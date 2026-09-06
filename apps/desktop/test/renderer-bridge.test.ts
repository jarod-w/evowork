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
import type { ProjectionRow, Store } from '@evowork/store';

import {
  createEventTranslator,
  createRendererActions,
  timeLabel,
  toTaskRow,
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

  it('空可见页不发请求 —— 04 §3.4 的有界校正，0 条也算一条边界', async () => {
    const adapter = { refreshAuthoritative: vi.fn(async () => 0) } as unknown as Adapter;
    const actions = createRendererActions({ ...base, adapter, store: fakeStore(() => undefined) });
    await actions.refreshVisible([]);
    expect(adapter.refreshAuthoritative).not.toHaveBeenCalled();
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
