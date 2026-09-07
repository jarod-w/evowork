/**
 * 渲染动作与事件翻译（`renderer-bridge.ts`）。
 *
 * 这个文件存在的理由是一条真实故障：preload 声明了六个动作、主进程只注册了审批一个，
 * 而适配层推给渲染层的又是**任务视角**的事件、渲染层认的是**组件视角**的。
 * 三处各自都有测试、合起来是断的 —— 所以这里测的全是"接缝"。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, UiEvent } from '@evowork/kernel-adapter';
import { openStore, type ProjectionRow, type Store } from '@evowork/store';

import {
  createEventTranslator,
  createRendererActions,
  timeLabel,
  toTaskRow,
  type ProjectPorts,
} from '../src/main/renderer-bridge.js';
import {
  ensureKernelConfig,
  ensurePaths,
  readGatewayToken,
  resolvePaths,
} from '../src/main/service-host.js';

function row(over: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    thread_id: 't1',
    title: '季度汇报',
    cwd: '/w',
    project_id: null,
    section_id: null,
    derived_status: 'running',
    last_turn_status: null,
    last_turn_id: null,
    scenario_id: null,
    mode_id: null,
    permission_id: null,
    model: null,
    plan_confirmed: 0,
    has_plan_item: 0,
    automation_id: null,
    artifact_count: 0,
    token_input: 0,
    token_output: 0,
    token_cached: 0,
    cost_estimate: 0,
    budget_limit: null,
    share_id: null,
    first_message: null,
    parent_thread_id: null,
    created_at: 1,
    updated_at: 1,
    recency_at: 1,
    archived: 0,
    ...over,
  };
}

function fakeStore(get: (id: string) => ProjectionRow | undefined): Store {
  return { threads: { get } } as unknown as Store;
}

/* ─────────────────── 项目动作测试的公共辅助（Task 9 也要用它们）─────────────────── */

/** 一个内存 sqlite，`createRendererActions` 内部会在它上面开 `createProjectRepo`。 */
function memoryStore(): Store {
  return openStore({ path: ':memory:' });
}

/**
 * 往 `artifact` 表插一行，只为了证明「移除空间」不碰这张表。
 * 字段照 `services/store/test/projects-repo.test.ts` 里那条 INSERT 的写法。
 */
function seedArtifact(store: Store, path: string): void {
  store.db
    .prepare(
      `INSERT INTO artifact (id, path, artifact_type, output_format, title, operation_kind,
                             version, source_signal, file_state, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(`af-${path}`, path, 'document', 'docx', 'r', 'create', 1, 'SKILL_REPORT', 'PRESENT', 1);
}

/** 只假造项目动作用得到的那几个 adapter 方法，其余留空——测的不是内核桥。 */
function fakeAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    listTasks: vi.fn(() => []),
    mirrorProjectCreate: vi.fn(async () => undefined),
    mirrorProjectUpdate: vi.fn(async () => undefined),
    mirrorProjectDelete: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Adapter;
}

/** 建 actions 的公共入口：默认给一个干净内存库 + 假 adapter，按需覆盖。 */
function makeActions(overrides: Partial<Parameters<typeof createRendererActions>[0]> = {}) {
  return createRendererActions({
    appName: 'EvoWork',
    appVersion: '0.0.0',
    store: memoryStore(),
    adapter: fakeAdapter(),
    ...overrides,
  });
}

describe('事件翻译：适配层的任务视角 → 渲染层的组件视角', () => {
  it('task-created 带上整行数据 —— 渲染层拿不到 store，自己补不出这一行', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 1000,
    );
    const out = translate({ type: 'task-created', threadId: 't1', title: '季度汇报' });
    expect(out).toEqual([
      {
        type: 'task-created',
        task: expect.objectContaining({ id: 't1', title: '季度汇报', status: 'running' }),
      },
    ]);
  });

  it('投影表里还没有这一行时**不发**半条事件', () => {
    const translate = createEventTranslator(
      fakeStore(() => undefined),
      () => 0,
    );
    expect(translate({ type: 'task-created', threadId: 't9', title: null })).toEqual([]);
  });

  it('增量在主进程侧累加成完整条目 —— 渲染层按 id 覆盖，收到半截会把正文冲掉', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 0,
    );
    translate({
      type: 'item-started',
      threadId: 't1',
      item: { id: 'i1', type: 'agentMessage', text: '你' } as never,
    });
    const out = translate({
      type: 'item-delta',
      threadId: 't1',
      itemId: 'i1',
      channel: 'agentMessage',
      delta: '好',
    });
    expect(out).toEqual([
      { type: 'item', taskId: 't1', item: { id: 'i1', type: 'agentMessage', text: '你好' } },
    ]);
  });

  it('没见过 item-started 的增量**不猜形状**，等 item-completed 给完整条目', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 0,
    );
    expect(
      translate({
        type: 'item-delta',
        threadId: 't1',
        itemId: 'ghost',
        channel: 'agentMessage',
        delta: 'x',
      }),
    ).toEqual([]);
  });

  /**
   * 这条守的是用户直接撞上的那个 bug：任务标着「失败」、对话里一个字都没有。
   * 内核**是**把原因发过来的（`Turn.error`，仅在 failed 时填充），是我们丢的。
   */
  it('失败的回合把内核给的原因带上来', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 0,
    );
    expect(
      translate({
        type: 'turn-completed',
        threadId: 't1',
        turnId: 'r1',
        status: 'failed',
        error: { message: '连不上模型网关', details: 'ECONNREFUSED 127.0.0.1:8787' },
      }),
    ).toEqual([
      {
        type: 'turn-failed',
        taskId: 't1',
        message: '连不上模型网关',
        details: 'ECONNREFUSED 127.0.0.1:8787',
      },
    ]);
  });

  it('成功的回合不吵人；失败但内核没给原因时也不编一个', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 0,
    );
    expect(
      translate({ type: 'turn-completed', threadId: 't1', turnId: 'r1', status: 'completed' }),
    ).toEqual([]);
    expect(
      translate({ type: 'turn-completed', threadId: 't1', turnId: 'r2', status: 'failed' }),
    ).toEqual([]);
  });

  /*
   * 「思考中…」永远停在那儿的根因不在渲染层，在这里。
   *
   * 内核的 `Reasoning` 只有 id / summary / content 三个字段（`v2/item.rs:280-286`），
   * **没有任何"跑完了"或"用了多久"的信号**。渲染层要区分这两态，就只能由
   * 收到 `item/completed` 的这一层把事实贴到条目上。
   */
  it('条目完成时打上 completed，并按 started→completed 量出耗时', () => {
    let clock = 0;
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => clock,
    );
    translate({
      type: 'item-started',
      threadId: 't1',
      item: { id: 'r1', type: 'reasoning' } as never,
    });
    clock = 12_400;
    const out = translate({
      type: 'item-completed',
      threadId: 't1',
      item: { id: 'r1', type: 'reasoning', content: ['先看表头'] } as never,
    });
    expect(out).toEqual([
      {
        type: 'item',
        taskId: 't1',
        item: {
          id: 'r1',
          type: 'reasoning',
          content: ['先看表头'],
          completed: true,
          durationSeconds: 12,
        },
      },
    ]);
  });

  /*
   * 没见过开始就没法量 —— **此时不填 durationSeconds**，让渲染层说「推理过程」。
   * 填 0 是把"量不到"说成"零秒"（CLAUDE.md §9.1）。
   */
  it('没见过 item-started 的条目只标 completed，不编一个 0 秒', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 5000,
    );
    const out = translate({
      type: 'item-completed',
      threadId: 't1',
      item: { id: 'r9', type: 'reasoning' } as never,
    });
    expect(out[0]).toMatchObject({ item: { completed: true } });
    expect((out[0] as { item: Record<string, unknown> }).item.durationSeconds).toBeUndefined();
  });

  /*
   * 中断与失败时内核**不会**给挂着的条目补 `item/completed`（它们确实没完成）。
   * 不收摊的话，任务标着「失败」而推理区还在说「思考中…」。
   */
  it('回合结束时收摊还挂着的条目，且只收这个任务的', () => {
    let clock = 0;
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => clock,
    );
    translate({
      type: 'item-started',
      threadId: 't1',
      item: { id: 'r1', type: 'reasoning' } as never,
    });
    translate({
      type: 'item-started',
      threadId: 't2',
      item: { id: 'r2', type: 'reasoning' } as never,
    });
    clock = 3000;

    const out = translate({
      type: 'turn-completed',
      threadId: 't1',
      turnId: 'x',
      status: 'interrupted',
    });
    expect(out).toEqual([
      {
        type: 'item',
        taskId: 't1',
        item: { id: 'r1', type: 'reasoning', completed: true, durationSeconds: 3 },
      },
    ]);

    // t2 还挂着（它属于另一个任务，可能正跑着）—— 再收一次也不该重复吐出 r1
    expect(
      translate({ type: 'turn-completed', threadId: 't1', turnId: 'y', status: 'completed' }),
    ).toEqual([]);
  });

  it('失败的回合先收摊再报原因，两条都不丢', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 0,
    );
    translate({
      type: 'item-started',
      threadId: 't1',
      item: { id: 'r1', type: 'reasoning' } as never,
    });
    const out = translate({
      type: 'turn-completed',
      threadId: 't1',
      turnId: 'x',
      status: 'failed',
      error: { message: '连不上模型网关' },
    });
    expect(out.map((e) => e.type)).toEqual(['item', 'turn-failed']);
  });

  it('第一条消息没有内核名字时，行标题回退到第一条消息', () => {
    const translate = createEventTranslator(
      fakeStore(() => row({ title: null, first_message: '把 data/ 下的三张表合并成季度汇总' })),
      () => 0,
    );
    const out = translate({ type: 'task-created', threadId: 't1', title: null });
    expect(out).toEqual([
      {
        type: 'task-created',
        task: expect.objectContaining({ title: '把 data/ 下的三张表合并成季度汇总' }),
      },
    ]);
  });

  it('名字与第一条消息都没有时才是 null（由 UI 显示「未命名任务」）', () => {
    const translate = createEventTranslator(
      fakeStore(() => row({ title: null, first_message: null })),
      () => 0,
    );
    const out = translate({ type: 'task-created', threadId: 't1', title: null });
    expect(out[0]).toMatchObject({ task: { title: null } });
  });

  it('UI 上没有落点的事件返回空数组（它们已在适配层落过库）', () => {
    const translate = createEventTranslator(
      fakeStore(() => row()),
      () => 0,
    );
    const noop: UiEvent[] = [
      { type: 'skills-changed' },
      { type: 'rate-limits-updated' },
      { type: 'queue-changed', threadId: 't1' },
    ];
    for (const event of noop) expect(translate(event)).toEqual([]);
  });
});

describe('时间戳只到"天"（01 §5.5）', () => {
  it('再细就要每分钟重渲染整张任务列表', () => {
    const now = 10 * 24 * 60 * 60_000;
    expect(timeLabel(now, now)).toBe('刚刚');
    expect(timeLabel(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(timeLabel(now - 3 * 60 * 60_000, now)).toBe('3 小时前');
    expect(timeLabel(now - 2 * 24 * 60 * 60_000, now)).toBe('2 天前');
    expect(timeLabel(null, now)).toBe('');
  });

  it('没有 cwd 时不塞一个 undefined 字段进去', () => {
    expect(toTaskRow(row({ cwd: null }), 1)).not.toHaveProperty('cwd');
  });
});

describe('send：首页不创建 Thread（03 §1）', () => {
  const base = { appName: 'EvoWork', appVersion: '0.0.0' };

  it('没有 threadId → createTask；有 threadId → sendMessage', async () => {
    const adapter = {
      createTask: vi.fn(async () => ({ threadId: 'new-1' })),
      sendMessage: vi.fn(async () => ({ queued: false })),
    } as unknown as Adapter;
    const actions = createRendererActions({
      ...base,
      adapter,
      store: fakeStore(() => undefined),
    });

    expect(await actions.send({ text: '做个周报' })).toEqual({ threadId: 'new-1' });
    expect(adapter.createTask).toHaveBeenCalledWith({
      input: [{ type: 'text', text: '做个周报' }],
    });

    expect(await actions.send({ threadId: 't1', text: '再来一条' })).toEqual({ threadId: 't1' });
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      threadId: 't1',
      input: [{ type: 'text', text: '再来一条' }],
    });
    // 第二条**没有**又建一个任务
    expect(adapter.createTask).toHaveBeenCalledTimes(1);
  });

  /**
   * 手选模型必须**既发出去、又存下来**（03 §2.4 + 04 §4）。
   *
   * 少任何一半都有一个具体的坏表现：
   *   · 只存不发 —— 这一轮还是旧模型，而用户刚刚就是为了这一轮才切的；
   *   · 只发不存 —— 下一轮 `sendMessage` 从投影表读回旧的 `row.model`，
   *     用户切了模型只生效一轮，然后悄悄换回去（而界面上仍显示他选的那个）。
   */
  it('新任务里手选模型：展开进 turn/start **并且**落进任务级设置', async () => {
    const adapter = {
      createTask: vi.fn(async () => ({ threadId: 'new-1' })),
      sendMessage: vi.fn(async () => ({ queued: false })),
      setTaskSettings: vi.fn(),
    } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });

    await actions.send({ text: '做个周报', modelId: 'evowork/kimi-k3' });

    expect(adapter.createTask).toHaveBeenCalledWith({
      input: [{ type: 'text', text: '做个周报' }],
      overrides: { model: 'evowork/kimi-k3' },
    });
    expect(adapter.setTaskSettings).toHaveBeenCalledWith('new-1', { model: 'evowork/kimi-k3' });
  });

  it('已有任务里换模型：同样两件事都做', async () => {
    const adapter = {
      createTask: vi.fn(async () => ({ threadId: 'new-1' })),
      sendMessage: vi.fn(async () => ({ queued: false })),
      setTaskSettings: vi.fn(),
    } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });

    await actions.send({ threadId: 't1', text: '换个模型再来', modelId: 'evowork/glm-flash' });

    expect(adapter.setTaskSettings).toHaveBeenCalledWith('t1', { model: 'evowork/glm-flash' });
    expect(adapter.sendMessage).toHaveBeenCalledWith({
      threadId: 't1',
      input: [{ type: 'text', text: '换个模型再来' }],
      overrides: { model: 'evowork/glm-flash' },
    });
  });

  it('没选模型时**不塞一个 overrides 进去** —— 场景默认值才能生效', async () => {
    const adapter = {
      createTask: vi.fn(async () => ({ threadId: 'new-1' })),
      sendMessage: vi.fn(async () => ({ queued: false })),
      setTaskSettings: vi.fn(),
    } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });

    await actions.send({ text: '做个周报' });

    expect(adapter.createTask).toHaveBeenCalledWith({
      input: [{ type: 'text', text: '做个周报' }],
    });
    expect(adapter.setTaskSettings).not.toHaveBeenCalled();
  });

  it('没有配置模型目录读取方时**说清楚**，不是回一个空列表假装没有模型', async () => {
    const adapter = { createTask: vi.fn(), sendMessage: vi.fn() } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });

    const result = await actions.listModels();
    expect(result.models).toEqual([]);
    // 空列表 + 空原因 = 下拉是空的而没人知道为什么
    expect(result.unavailable).toBeTruthy();
  });

  it('这个版本不能保存密钥时如实说，不静默丢掉用户刚贴的 key', async () => {
    const adapter = { createTask: vi.fn(), sendMessage: vi.fn() } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });
    const result = await actions.applyModelAccess({ deepseekApiKey: 'sk' });
    expect(result.models).toEqual([]);
    expect(result.reason).toBe('no-keys');
    expect(result.unavailable).toContain('gateway.env');
  });

  it('空可见页不发请求 —— 04 §3.4 的有界校正，0 条也算一条边界', async () => {
    const adapter = { refreshAuthoritative: vi.fn(async () => 0) } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });
    await actions.refreshVisible([]);
    expect(adapter.refreshAuthoritative).not.toHaveBeenCalled();
  });

  it('打开任务把权威条目标成已完成；列表失败时回落快显缓存并说出原因', async () => {
    const adapter = {
      openTask: vi.fn(async () => ({
        cached: [
          {
            threadId: 't1',
            seq: 1,
            itemId: 'i1',
            itemType: 'agentMessage',
            summary: '缓存里的一句',
            createdAt: 1,
          },
        ],
        items: Promise.resolve([
          {
            id: 'u1',
            type: 'userMessage' as const,
            content: [{ type: 'text' as const, text: '问' }],
          },
          { id: 'a1', type: 'agentMessage' as const, text: '完整回答' },
        ]),
      })),
    } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });

    const ok = await actions.openTask({ threadId: 't1' });
    expect(ok.items).toEqual([
      {
        id: 'u1',
        type: 'userMessage',
        content: [{ type: 'text', text: '问' }],
        completed: true,
      },
      { id: 'a1', type: 'agentMessage', text: '完整回答', completed: true },
    ]);
    expect(ok.incomplete).toBeUndefined();

    adapter.openTask = vi.fn(async () => ({
      cached: [
        {
          threadId: 't1',
          seq: 1,
          itemId: 'i1',
          itemType: 'agentMessage',
          summary: '缓存里的一句',
          createdAt: 1,
        },
      ],
      items: Promise.reject(new Error('connection refused')),
    }));
    const fallback = await actions.openTask({ threadId: 't1' });
    expect(fallback.items).toEqual([
      { id: 'i1', type: 'agentMessage', completed: true, text: '缓存里的一句' },
    ]);
    expect(fallback.incomplete).toContain('connection refused');
  });
});

describe('首次运行装内核配置', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * 少了这一步，内核对**每一次** `thread/start` 都回
   * `default_permissions requires a [permissions] table`（F21），
   * 而 UI 上只表现为"回车之后什么都没发生"。
   */
  it('装到内核家目录（不是 ~/.evowork/）—— 内核只读它自己家目录下的 config.toml', () => {
    const paths = resolvePaths(dir);
    ensurePaths(paths);
    const template = join(dir, 'config.toml.template');
    writeFileSync(template, '[permissions.evowork-workspace]\nextends = ":workspace"\n', 'utf8');

    expect(ensureKernelConfig(paths, template)).toBe(true);
    expect(readFileSync(join(paths.kernelHome, 'config.toml'), 'utf8')).toContain(
      'evowork-workspace',
    );
  });

  it('已存在就不覆盖 —— 企业会改这个文件（私有网关地址、锁死的档位）', () => {
    const paths = resolvePaths(dir);
    ensurePaths(paths);
    const template = join(dir, 'config.toml.template');
    writeFileSync(template, 'from = "template"\n', 'utf8');
    writeFileSync(join(paths.kernelHome, 'config.toml'), 'from = "enterprise"\n', 'utf8');

    expect(ensureKernelConfig(paths, template)).toBe(false);
    expect(readFileSync(join(paths.kernelHome, 'config.toml'), 'utf8')).toContain('enterprise');
  });

  it('模板不存在时安静跳过（开发时可能没有 config/）', () => {
    const paths = resolvePaths(dir);
    ensurePaths(paths);
    expect(ensureKernelConfig(paths, join(dir, 'nope.toml'))).toBe(false);
  });
});

describe('网关访问令牌（内核从进程环境取它）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-tok-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * 从访达双击启动的应用**不继承任何 shell 环境变量** —— 所以文件那条路不是备选，
   * 是 GUI 场景下唯一能走的。少了它，内核对每一次回合回
   * `Missing environment variable: EVOWORK_GATEWAY_TOKEN`，界面上就是"任务失败了"。
   */
  it('环境变量优先，其次是 ~/.evowork/gateway-token', () => {
    const paths = resolvePaths(dir);
    ensurePaths(paths);
    expect(readGatewayToken(paths, {})).toBeUndefined();

    writeFileSync(paths.gatewayToken, 'from-file\n', 'utf8');
    expect(readGatewayToken(paths, {})).toBe('from-file');
    expect(readGatewayToken(paths, { EVOWORK_GATEWAY_TOKEN: 'from-env' })).toBe('from-env');
  });

  it('空文件与只有空白的环境变量都算「没有」，不会传一个空令牌进去', () => {
    const paths = resolvePaths(dir);
    ensurePaths(paths);
    writeFileSync(paths.gatewayToken, '\n', 'utf8');
    expect(readGatewayToken(paths, { EVOWORK_GATEWAY_TOKEN: '   ' })).toBeUndefined();
  });
});

describe('项目动作（spec §2.6）', () => {
  function ports(overrides: Partial<ProjectPorts> = {}): ProjectPorts {
    return {
      home: '/Users/li',
      rootExists: () => true,
      // 默认恒等：软链的负面用例各自覆盖它
      realpath: async (p) => p,
      pickDirectory: async () => '/w/new',
      readDir: async () => [{ name: 'src', isDirectory: true }],
      openFolder: async () => {},
      readTextFile: async () => undefined,
      writeTextFile: async () => {},
      ...overrides,
    };
  }

  it('新建空间会落库并回一份新列表 —— 渲染层不必再拉一次', async () => {
    const actions = makeActions({ projectPorts: ports() });
    const result = await actions.createProject({ name: '季度汇报', path: '/w/new' });
    expect(result.ok).toBe(true);
    expect(result.projects.map((p) => p.name)).toContain('季度汇报');
  });

  it('选中硬拦截目录被拒，且给一句能显示的话 —— 不抛错（抛错=点了没反应）', async () => {
    const actions = makeActions({ projectPorts: ports() });
    const result = await actions.createProject({ name: '密钥', path: '/Users/li/.ssh' });
    expect(result.ok).toBe(false);
    expect(result.refused).toBeTruthy();
    expect(result.projects).toHaveLength(0);
  });

  it('镜像失败不影响本机建成 —— 用户什么都不该看见', async () => {
    const actions = makeActions({
      projectPorts: ports(),
      adapter: fakeAdapter({ mirrorProjectCreate: async () => undefined }),
    });
    const result = await actions.createProject({ name: 'A', path: '/w/a' });
    expect(result.ok).toBe(true);
  });

  it('移除只解绑：不碰磁盘，也不碰 artifact 索引', async () => {
    /*
     * 断言的是**行为**：移除期间没有任何一个写盘端口被调用，且 artifact 表原封不动。
     * 光断言 `projects` 空了证明不了"没删文件" —— 而写反了的代价正是用户丢文件。
     */
    const writeTextFile = vi.fn(async () => {});
    const store = memoryStore();
    seedArtifact(store, '/w/a/r.docx');

    const actions = makeActions({ store, projectPorts: ports({ writeTextFile }) });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';

    const after = await actions.removeProject({ id });

    expect(after.projects).toHaveLength(0);
    expect(writeTextFile).not.toHaveBeenCalled();
    const left = store.db.prepare('SELECT COUNT(*) AS n FROM artifact').get() as { n: number };
    expect(left.n).toBe(1);
  });

  it('路径失效时卡片标 rootMissing，且路径原样保留', async () => {
    const actions = makeActions({ projectPorts: ports({ rootExists: () => false }) });
    await actions.createProject({ name: 'A', path: '/w/gone' });
    const list = await actions.listProjects();
    expect(list.projects[0]?.rootMissing).toBe(true);
    expect(list.projects[0]?.rootDisplay).toContain('gone');
  });

  it('文件树展开越界路径返回空数组 —— 渲染层传 <root>/../.ssh 时主进程拒读', async () => {
    let readPath: string | undefined;
    const actions = makeActions({
      projectPorts: ports({
        readDir: async (p) => {
          readPath = p;
          return [];
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';

    const out = await actions.listProjectDir({ id, path: '/w/a/../.ssh' });
    expect(out).toEqual([]);
    // 关键：**根本没去读盘**，不是读了再过滤
    expect(readPath).toBeUndefined();
  });

  it('root 里的软链指向外面时拒读 —— 字符串判定看不出来，realpath 之后必须复查', async () => {
    let readPath: string | undefined;
    const actions = makeActions({
      projectPorts: ports({
        // `<root>/escape` 其实指向 /etc
        realpath: async (p) => (p === '/w/a/escape' ? '/etc' : p),
        readDir: async (p) => {
          readPath = p;
          return [];
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';

    expect(await actions.listProjectDir({ id, path: '/w/a/escape' })).toEqual([]);
    // 又一次：**根本没读盘**
    expect(readPath).toBeUndefined();
  });

  it('AGENTS.md 只写 <root>/AGENTS.md，渲染层传别的路径也没用', async () => {
    let written: { path: string; content: string } | undefined;
    const actions = makeActions({
      projectPorts: ports({
        writeTextFile: async (path, content) => {
          written = { path, content };
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';

    await actions.writeAgentsMemo({ id, content: '记住：报告用中文' });
    expect(written?.path).toBe('/w/a/AGENTS.md');
  });

  it('文件不存在时 readAgentsMemo 报 exists:false 而不是空串 —— 页面据此说"还没有"', async () => {
    const actions = makeActions({ projectPorts: ports({ readTextFile: async () => undefined }) });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';

    const memo = await actions.readAgentsMemo({ id });
    expect(memo.exists).toBe(false);
    expect(memo.content).toBe('');
  });

  /*
   * ── 补充：安全边界的另一半（realpath 之后复查）不能只在"字符串就露馅"的用例上成立 ──
   *
   * 下面这组把 `listProjectDir` / `readAgentsMemo` / `writeAgentsMemo` 三个真正碰盘的
   * 动作各测两遍：realpath 解析不了（返回 undefined）与 realpath 直接抛错。
   * 两种都必须拒绝，且**读/写端口一次都不能被调用** —— 断言的是"根本没读/没写"，
   * 不是"读了/写了但结果被扔掉"，因为后一种情况下磁盘副作用已经发生了。
   */

  it('listProjectDir：realpath 解析不了（返回 undefined）时拒读，不是读了再过滤', async () => {
    let readCalled = false;
    const actions = makeActions({
      projectPorts: ports({
        realpath: async () => undefined,
        readDir: async () => {
          readCalled = true;
          return [];
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';
    expect(await actions.listProjectDir({ id, path: '/w/a/x' })).toEqual([]);
    expect(readCalled).toBe(false);
  });

  it('listProjectDir：realpath 直接抛错时同样拒读 —— 失败一律收紧，不能让异常从安全判定里漏出去', async () => {
    let readCalled = false;
    const actions = makeActions({
      projectPorts: ports({
        realpath: async () => {
          throw new Error('EACCES');
        },
        readDir: async () => {
          readCalled = true;
          return [];
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';
    expect(await actions.listProjectDir({ id, path: '/w/a/x' })).toEqual([]);
    expect(readCalled).toBe(false);
  });

  it('readAgentsMemo：root 的 realpath 落在外面时拒读，从不调用 readTextFile', async () => {
    let readCalled = false;
    const actions = makeActions({
      projectPorts: ports({
        // root 本身被 realpath 判定成落在别处（比如 root 被换成了一个软链）
        realpath: async () => '/etc',
        readTextFile: async () => {
          readCalled = true;
          return undefined;
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';
    const memo = await actions.readAgentsMemo({ id });
    expect(memo).toEqual({ exists: false, content: '' });
    expect(readCalled).toBe(false);
  });

  it('readAgentsMemo：realpath 抛错时拒读，从不调用 readTextFile', async () => {
    let readCalled = false;
    const actions = makeActions({
      projectPorts: ports({
        realpath: async () => {
          throw new Error('ENOENT');
        },
        readTextFile: async () => {
          readCalled = true;
          return undefined;
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';
    const memo = await actions.readAgentsMemo({ id });
    expect(memo).toEqual({ exists: false, content: '' });
    expect(readCalled).toBe(false);
  });

  it('writeAgentsMemo：root 的 realpath 落在外面时拒写，从不调用 writeTextFile', async () => {
    let writeCalled = false;
    const actions = makeActions({
      projectPorts: ports({
        realpath: async () => '/etc',
        writeTextFile: async () => {
          writeCalled = true;
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';
    const out = await actions.writeAgentsMemo({ id, content: 'x' });
    expect(out.ok).toBe(false);
    expect(writeCalled).toBe(false);
  });

  it('writeAgentsMemo：realpath 抛错时拒写，从不调用 writeTextFile', async () => {
    let writeCalled = false;
    const actions = makeActions({
      projectPorts: ports({
        realpath: async () => {
          throw new Error('EPERM');
        },
        writeTextFile: async () => {
          writeCalled = true;
        },
      }),
    });
    const created = await actions.createProject({ name: 'A', path: '/w/a' });
    const id = created.projects[0]?.id ?? '';
    const out = await actions.writeAgentsMemo({ id, content: 'x' });
    expect(out.ok).toBe(false);
    expect(writeCalled).toBe(false);
  });
});
