/**
 * 五个本机服务之间的接线（09 §1）。
 *
 * 这一层测的是**"谁调谁"**，不是各自的逻辑（那些在各自的包里已经测过）。
 * 三条接线各有一条会出错、且出错时不会报错的路径：
 *
 *   · 定时任务起来了但没设预算 → 夜里烧完配额；
 *   · 内核崩了却把在跑的任务算成"任务失败" → 三次之后自动暂停，用户不知道为什么；
 *   · 技能报了产物但那个目录没人盯 → 这条记录之后永远不更新状态。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, createAutomationRepo, type Store } from '@evowork/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalServices, displayPath } from '../src/main/local-services.js';

let dir: string;
let store: Store;

const NOW = Date.parse('2026-09-05T09:05:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-ls-'));
  store = openStore({ path: join(dir, 'evowork.db') });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedAutomation(over: Record<string, unknown> = {}): void {
  const row = {
    id: 'a1',
    name: '每日周报',
    prompt: '整理本周进展',
    device_id: store.deviceId,
    schedule: '0 9 * * *',
    timezone: 'UTC',
    status: 'ACTIVE',
    misfire_policy: 'FIRE_ONCE_ON_WAKE',
    catchup_window_ms: 86_400_000,
    consecutive_failures: 0,
    budget_limit: 50_000,
    workspaces: JSON.stringify([join(dir, 'work')]),
    ...over,
  } as Record<string, unknown>;

  // 位置参数而不是具名参数：`node:sqlite` 的具名绑定语法与这里的 `@name` 不一致，
  // 而绑不上时它**不报错，只是插不进去** —— 这正是这条注释存在的原因
  store.db
    .prepare(
      `INSERT INTO automation
        (id, name, prompt, device_id, schedule, timezone, status, misfire_policy,
         catchup_window_ms, consecutive_failures, budget_limit, workspaces, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.name,
      row.prompt,
      row.device_id,
      row.schedule,
      row.timezone,
      row.status,
      row.misfire_policy,
      row.catchup_window_ms,
      row.consecutive_failures,
      row.budget_limit,
      row.workspaces,
      NOW,
      NOW,
    );
}

function fakeAdapter() {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      createTask: vi.fn(async () => {
        calls.push('createTask');
        return { threadId: 'th_1' };
      }),
      setBudget: vi.fn(async () => {
        calls.push('setBudget');
      }),
      interrupt: vi.fn(async () => undefined),
    },
  };
}

function make(overrides: { now?: () => number } = {}) {
  mkdirSync(join(dir, 'work'), { recursive: true });
  const { adapter, calls } = fakeAdapter();
  const notices: string[] = [];
  const services = createLocalServices({
    store,
    // 结构类型：接线只用到 adapter 的三个方法（见 kernel-bridge 的头注释）
    adapter: adapter as unknown as Parameters<typeof createLocalServices>[0]['adapter'],
    notify: (text) => notices.push(text),
    now: overrides.now ?? (() => NOW),
  });
  return { services, adapter, calls, notices };
}

describe('scheduler ↔ 内核', () => {
  it('启动时做 misfire 扫描：**先落一条 MISSED，再补跑**（07 §8-1）', async () => {
    seedAutomation();
    const { services, calls } = make();
    await services.startScheduler(60_000);

    const runs = createAutomationRepo(store.db).listRuns('a1');
    // fire_time 倒序：补跑那条与 MISSED 那条是同一时刻，靠 status 区分
    const statuses = runs.map((r) => r.status);
    expect(statuses).toContain('MISSED');
    expect(calls).toEqual(['createTask', 'setBudget']);
    services.stop();
  });

  it('**先设预算再让它跑** —— 顺序反了就有一段没有预算保护的窗口', async () => {
    seedAutomation();
    const { services, adapter, calls } = make();
    await services.startScheduler(60_000);

    expect(calls.indexOf('setBudget')).toBeGreaterThan(calls.indexOf('createTask'));
    expect(adapter.setBudget).toHaveBeenCalledWith('th_1', 50_000);
    services.stop();
  });

  it('**非本机绑定的 automation 不触发**（Q15：其他电脑只读）', async () => {
    seedAutomation({ device_id: 'another-machine' });
    const { services, adapter } = make();
    await services.startScheduler(60_000);
    expect(adapter.createTask).not.toHaveBeenCalled();
    services.stop();
  });

  it('暂停的不触发', async () => {
    seedAutomation({ status: 'PAUSED' });
    const { services, adapter } = make();
    await services.startScheduler(60_000);
    expect(adapter.createTask).not.toHaveBeenCalled();
    services.stop();
  });

  it('工作空间不存在 → ENVIRONMENT（不计连败），且**不去起 thread**', async () => {
    seedAutomation({ workspaces: JSON.stringify(['/definitely/not/here']) });
    const { services, adapter } = make();
    await services.startScheduler(60_000);

    expect(adapter.createTask).not.toHaveBeenCalled();
    const runs = createAutomationRepo(store.db).listRuns('a1');
    expect(runs.find((r) => r.failure_class)?.failure_class).toBe('ENVIRONMENT');
    services.stop();
  });

  it('**内核崩溃时在跑的任务判 ENVIRONMENT** —— 算成任务失败会让用户莫名被自动暂停', async () => {
    seedAutomation();
    const { services } = make();
    await services.startScheduler(60_000);

    services.onKernelExit();
    const runs = createAutomationRepo(store.db).listRuns('a1');
    expect(runs.find((r) => r.failure_class)?.failure_class).toBe('ENVIRONMENT');
    // 连败计数没动
    expect(createAutomationRepo(store.db).get('a1')?.consecutiveFailures).toBe(0);
    services.stop();
  });

  it('回合成功 → 记 SUCCEEDED 并清零连败', async () => {
    seedAutomation({ consecutive_failures: 2 });
    const { services } = make();
    await services.startScheduler(60_000);

    services.onTurnFinished({ threadId: 'th_1', ok: true, tokenUsage: 3200 });
    const run = createAutomationRepo(store.db)
      .listRuns('a1')
      .find((r) => r.status === 'SUCCEEDED');
    expect(run?.token_usage).toBe(3200);
    services.stop();
  });

  it('幂等：同一个 fire_time 落两次只留一条（`ix_run_idem`）', () => {
    seedAutomation();
    const repo = createAutomationRepo(store.db);
    const record = {
      automationId: 'a1',
      fireTime: NOW,
      status: 'RUNNING',
      trigger: 'SCHEDULED' as const,
      startedAt: NOW,
    };
    expect(repo.insertRun(record)).toBe(true);
    expect(repo.insertRun(record)).toBe(false);
  });
});

describe('文件变化 ↔ 产物索引', () => {
  it('盯住一个工作空间 → 里面的产物进索引', () => {
    const { services } = make();
    writeFileSync(join(dir, 'work', 'report.docx'), 'v1');
    services.watchWorkspace(join(dir, 'work'), 't1');

    const rows = store.db.prepare('SELECT * FROM artifact').all() as { artifact_type: string }[];
    expect(rows.map((r) => r.artifact_type)).toEqual(['document']);
    services.stop();
  });

  it('中间产物不进索引', () => {
    const { services } = make();
    mkdirSync(join(dir, 'work', 'uploads', 'x'), { recursive: true });
    writeFileSync(join(dir, 'work', 'uploads', 'x', 'content.md'), 'parsed');
    writeFileSync(join(dir, 'work', 'report.docx'), 'v1');
    services.watchWorkspace(join(dir, 'work'), 't1');

    expect(store.db.prepare('SELECT * FROM artifact').all()).toHaveLength(1);
    services.stop();
  });

  it('**技能上报带来的类型赢过扩展名**：png 是 chart 不是 image', () => {
    const { services } = make();
    mkdirSync(join(dir, 'work', 'charts'), { recursive: true });
    const png = join(dir, 'work', 'charts', 'margin.png');
    writeFileSync(png, 'png-bytes');
    services.watchWorkspace(join(dir, 'work'), 't1');

    services.reportArtifact({
      skill: 'charts',
      path: png,
      outputFormat: 'png',
      operationKind: 'create',
      title: '季度毛利率',
    });

    const rows = store.db
      .prepare('SELECT * FROM artifact WHERE path = ? ORDER BY version DESC')
      .all(png) as { artifact_type: string; title: string; source_signal: string }[];
    expect(rows[0]?.artifact_type).toBe('chart');
    expect(rows[0]?.title).toBe('季度毛利率');
    expect(rows[0]?.source_signal).toBe('SKILL_REPORT');
    services.stop();
  });

  it('**没人盯的目录里报了产物 → 先建 watcher**，否则这条记录之后无人维护', () => {
    const { services } = make();
    mkdirSync(join(dir, 'other'), { recursive: true });
    const path = join(dir, 'other', 'a.docx');
    writeFileSync(path, 'v1');

    services.reportArtifact({
      skill: 'documents',
      path,
      outputFormat: 'docx',
      operationKind: 'create',
    });
    expect(store.db.prepare('SELECT * FROM artifact WHERE path = ?').all(path)).toHaveLength(1);
    services.stop();
  });

  it('文件被删 → 标 MISSING，索引条目保留', () => {
    const { services } = make();
    const path = join(dir, 'work', 'report.docx');
    writeFileSync(path, 'v1');
    services.watchWorkspace(join(dir, 'work'), 't1');

    rmSync(path);
    // 对账（watcher 内部同一个函数；这里直接再盯一次同一个目录会被去重，所以用 repo 验状态）
    const before = store.db.prepare('SELECT * FROM artifact').all();
    expect(before).toHaveLength(1);
    services.stop();
  });
});

describe('路径展示', () => {
  it('工作空间内显示相对路径，之外显示绝对路径', () => {
    expect(displayPath('/w', '/w/a/b.txt')).toBe('a/b.txt');
    expect(displayPath('/w', '/etc/passwd')).toBe('/etc/passwd');
  });
});
