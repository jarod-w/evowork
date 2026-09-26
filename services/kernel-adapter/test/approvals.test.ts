import { SERVER_REQUEST } from '@evowork/protocol';
import { describe, expect, it } from 'vitest';

import {
  createApprovalRouter,
  INTERACTIVE_POLICY,
  UNATTENDED_POLICY,
  type ApprovalReply,
  type PendingApproval,
} from '../src/approvals.js';

/** 手动推进的定时器：审批的超时策略以分钟计，测试不能真等。 */
function manualTimers() {
  const queue: { at: number; fn: () => void }[] = [];
  let clock = 0;
  return {
    now: () => clock,
    setTimeoutFn: ((fn: () => void, ms = 0) => {
      queue.push({ at: clock + ms, fn });
      return queue.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    async advance(ms: number): Promise<void> {
      clock += ms;
      const due = queue.filter((t) => t.at <= clock);
      for (const t of due) {
        queue.splice(queue.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('审批必须回复（F14：内核会一直等）', () => {
  it('用户的决定被转成内核认识的形状', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    const reply = await router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      command: 'pip install openpyxl',
    });
    expect(reply).toEqual({ decision: 'accept' });
  });

  /*
   * 追问的回复是**按问题 id 归位的答案**：`{ answers: { [id]: { answers: [...] } } }`
   * （`v2/item.rs:1744-1753`）。回一个裸 `answer` 不会报错 —— 内核兜一个空 map
   * （`bespoke_event_handling.rs:1676-1681`），用户填的东西工具一个字都收不到。
   */
  it('追问回的是按问题 id 归位的答案，不是裸 answer', async () => {
    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept', answer: '用 2026Q2 的数据' }),
    });
    const reply = await router.handle(SERVER_REQUEST.toolRequestUserInput, {
      threadId: 't1',
      itemId: 'i1',
      questions: [{ id: 'q_quarter', question: '用哪个季度的数据？', options: null }],
    });
    expect(reply).toEqual({ answers: { q_quarter: { answers: ['用 2026Q2 的数据'] } } });
  });

  /* 选项没有 id，身份就是 label（`ToolRequestUserInputOption { label, description }`）。 */
  it('选项式追问回选中项的 label', async () => {
    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept', optionId: '2026Q2' }),
    });
    const reply = await router.handle(SERVER_REQUEST.toolRequestUserInput, {
      threadId: 't1',
      itemId: 'i1',
      questions: [
        {
          id: 'q_quarter',
          question: '用哪个季度？',
          options: [
            { label: '2026Q1', description: '' },
            { label: '2026Q2', description: '' },
          ],
        },
      ],
    });
    expect(reply).toEqual({ answers: { q_quarter: { answers: ['2026Q2'] } } });
  });

  it('答不上来时回空 map，而不是把 decision 塞进去', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'decline' }) });
    const reply = await router.handle(SERVER_REQUEST.toolRequestUserInput, {
      threadId: 't1',
      itemId: 'i1',
      questions: [{ id: 'q1', question: '?', options: null }],
    });
    expect(reply).toEqual({ answers: {} });
  });

  /*
   * 权限审批回的是**授予了什么**（`{ permissions, scope }`，`v2/permissions.rs:799-807`），
   * 不是"同不同意"。回 `{ decision }` 同样不报错 —— 兜底是空 profile，
   * 于是「允许」和「拒绝」给出的东西一样多：都是零。
   */
  it('权限审批：允许 = 把请求里的 profile 原样回授', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    const requested = { network: { enabled: true }, fileSystem: { read: ['/w'], write: null } };
    const reply = await router.handle(SERVER_REQUEST.permissionsRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      permissions: requested,
    });
    // 不在这里裁剪：内核随后会与环境策略求交，我们再削一刀结果就没人说得清了
    expect(reply).toEqual({ permissions: requested, scope: 'turn' });
  });

  it('权限审批：拒绝 = 空 profile（不是 decision: decline）', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'decline' }) });
    const reply = await router.handle(SERVER_REQUEST.permissionsRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    expect(reply).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('权限审批：本次会话都允许 → scope=session', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'acceptForSession' }) });
    const reply = await router.handle(SERVER_REQUEST.permissionsRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    expect(reply).toEqual({ permissions: { network: { enabled: true } }, scope: 'session' });
  });

  it('**UI 侧出错时也必须回复**，且回 decline（出错时选择不做，而不是选择做）', async () => {
    const router = createApprovalRouter({
      ask: async () => {
        throw new Error('窗口被关掉了');
      },
    });
    const reply = await router.handle(SERVER_REQUEST.fileChangeRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
    });
    expect(reply).toEqual({ decision: 'decline' });
  });

  it('不支持的方法明确报错，而不是回一个内核不认识的形状', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    await expect(router.handle('item/somethingElse', {})).rejects.toThrow(/未支持/);
  });
});

describe('两套超时策略（10 §3.6）', () => {
  it('交互式任务：提醒 → 升级，但**不自动拒绝**（用户回来还能继续）', async () => {
    const timers = manualTimers();
    const stages: string[] = [];
    let resolveUser: (r: ApprovalReply) => void = () => {};
    const router = createApprovalRouter({
      ask: () => new Promise<ApprovalReply>((resolve) => (resolveUser = resolve)),
      isUnattended: () => false,
      onTimeoutStage: (_a, stage) => stages.push(stage),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const inflight = router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
    });

    await timers.advance(INTERACTIVE_POLICY.remindAfterMs);
    expect(stages).toEqual(['remind']);

    await timers.advance(INTERACTIVE_POLICY.escalateAfterMs);
    expect(stages).toEqual(['remind', 'escalate']);

    // 再过两小时也不会自动拒绝
    await timers.advance(2 * 60 * 60_000);
    expect(stages).toEqual(['remind', 'escalate']);
    expect(router.pendingList()).toHaveLength(1);

    resolveUser({ decision: 'accept' });
    await expect(inflight).resolves.toEqual({ decision: 'accept' });
    expect(router.pendingList()).toHaveLength(0);
  });

  it('定时任务：**超时 10 分钟自动 Decline**（没人看着，挂着会占并发额度）', async () => {
    const timers = manualTimers();
    const stages: string[] = [];
    const router = createApprovalRouter({
      // 用户永不回复
      ask: () => new Promise<ApprovalReply>(() => {}),
      isUnattended: () => true,
      onTimeoutStage: (_a, stage) => stages.push(stage),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const inflight = router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't-auto',
      itemId: 'i1',
    });

    await timers.advance(UNATTENDED_POLICY.autoDeclineAfterMs ?? 0);
    await expect(inflight).resolves.toEqual({ decision: 'decline' });
    expect(stages).toContain('auto-decline');
    expect(router.pendingList()).toHaveLength(0);
  });

  it('无人值守判定来自"这个 thread 是不是定时任务"，默认按交互式（更保守）', async () => {
    const timers = manualTimers();
    const seen: PendingApproval[] = [];
    const router = createApprovalRouter({
      ask: async (a) => {
        seen.push(a);
        return { decision: 'accept' };
      },
      // 不提供 isUnattended
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
    });
    expect(seen[0]?.unattended).toBe(false);
  });
});

describe('待审批队列的全局可见性（10 §3.5）', () => {
  it('按到达顺序排列，**不做"全部允许"**', async () => {
    const timers = manualTimers();
    const snapshots: readonly PendingApproval[][] = [];
    const pushes: PendingApproval[][] = [];
    const router = createApprovalRouter({
      ask: () => new Promise<ApprovalReply>(() => {}),
      onPendingChanged: (list) => pushes.push([...list]),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    void router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'first',
    });
    await timers.advance(1000);
    void router.handle(SERVER_REQUEST.fileChangeRequestApproval, {
      threadId: 't2',
      itemId: 'second',
    });

    const list = router.pendingList();
    expect(list.map((a) => a.itemId)).toEqual(['first', 'second']);
    expect(list.map((a) => a.kind)).toEqual(['command', 'fileChange']);
    expect(pushes.at(-1)).toHaveLength(2);
    expect(snapshots).toHaveLength(0);
  });
});

describe('「本次任务内都允许」的可用条件（10 §3.3）', () => {
  function approval(over: Partial<PendingApproval>): PendingApproval {
    return {
      id: 'a1',
      kind: 'fileChange',
      threadId: 't1',
      params: {},
      receivedAtMs: 0,
      unattended: false,
      ...over,
    };
  }

  /*
   * 判定依据是 `fileChanges`（适配层按 itemId 反查来的），**不是 `params.changes`** ——
   * 内核的审批 RPC 从不发那个字段。这几条以前自己往 params 里塞一个内核不会发的形状，
   * 于是测试全绿而线上恒为 false：文件改动的「本次会话都允许」一次都没出现过。
   */
  it('批量变更**不提供** —— 一次点击放开整个会话的写权限风险过高', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(
      router.allowsAcceptForSession(
        approval({
          fileChanges: [
            { path: '/w/a.txt', kind: 'add', outsideWorkspace: false },
            { path: '/w/b.txt', kind: 'add', outsideWorkspace: false },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('单文件、非删除的变更可以提供', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(
      router.allowsAcceptForSession(
        approval({ fileChanges: [{ path: '/w/a.txt', kind: 'add', outsideWorkspace: false }] }),
      ),
    ).toBe(true);
  });

  it('删除操作不提供（10 §3.3：删除单独着色且不折叠，更不该被一键放开）', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(
      router.allowsAcceptForSession(
        approval({ fileChanges: [{ path: '/w/a.txt', kind: 'delete', outsideWorkspace: false }] }),
      ),
    ).toBe(false);
  });

  /* 不知道改了什么，就不能一键放开 —— 查不到时倒向保守，和以前的表现一致。 */
  it('清单查不到时不提供', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(router.allowsAcceptForSession(approval({}))).toBe(false);
  });

  it('命令审批可以提供（它的范围是"这条命令"，不是"整个工作空间的写权限"）', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(router.allowsAcceptForSession(approval({ kind: 'command' }))).toBe(true);
  });
});

describe('审批日志不带正文（10 §6 的"不记什么"）', () => {
  it('命令、diff、追问正文都不进日志字段', async () => {
    const records: { event: string; fields: Record<string, unknown> }[] = [];
    const fakeLogger = {
      debug: () => {},
      info: (event: string, fields?: Record<string, unknown>) =>
        records.push({ event, fields: fields ?? {} }),
      warn: (event: string, fields?: Record<string, unknown>) =>
        records.push({ event, fields: fields ?? {} }),
      error: (event: string, fields?: Record<string, unknown>) =>
        records.push({ event, fields: fields ?? {} }),
      child: () => fakeLogger,
      registry: undefined as never,
    };

    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept' }),
      logger: fakeLogger as never,
    });
    await router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      command: 'psql -c "select * from 客户欠款"',
      reason: '这个命令会连接数据库',
    });

    const dump = JSON.stringify(records);
    expect(dump).not.toContain('psql');
    expect(dump).not.toContain('客户欠款');
    expect(records[0]?.event).toBe('adapter.approval.received');
  });
});

describe('MCP elicitation 不套用 command decision 回复', () => {
  const params = {
    threadId: 't',
    turnId: 'turn',
    serverName: 'cua_repl',
    mode: 'form',
    message: '允许应用？',
    requestedSchema: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['task', 'always'] } },
      required: ['scope'],
    },
  };
  it.each(['task', 'always'])('用户明确选择 %s 才发送结构化内容', async (optionId) => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept', optionId }) });
    expect(await router.handle(SERVER_REQUEST.mcpServerElicitation, params)).toEqual({
      action: 'accept',
      content: { scope: optionId },
      _meta: null,
    });
  });
  it.each(['decline', 'cancel'] as const)('%s 回复没有授权内容', async (decision) => {
    const router = createApprovalRouter({ ask: async () => ({ decision, optionId: 'always' }) });
    expect(await router.handle(SERVER_REQUEST.mcpServerElicitation, params)).toEqual({
      action: decision,
      content: null,
      _meta: null,
    });
  });
  it('不能以普通 accept 或未知枚举值接受未支持表单', async () => {
    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept', optionId: 'injected' }),
    });
    expect(await router.handle(SERVER_REQUEST.mcpServerElicitation, params)).toHaveProperty(
      'action',
      'decline',
    );
    expect(
      await router.handle(SERVER_REQUEST.mcpServerElicitation, { ...params, mode: 'url' }),
    ).toHaveProperty('action', 'decline');
  });
  it('无人值守或无回合不弹 CU 授权', async () => {
    let asked = false;
    const router = createApprovalRouter({
      isUnattended: () => true,
      ask: async () => {
        asked = true;
        return { decision: 'accept', optionId: 'always' };
      },
    });
    expect(await router.handle(SERVER_REQUEST.mcpServerElicitation, params)).toHaveProperty(
      'action',
      'decline',
    );
    expect(asked).toBe(false);
  });
  it('结束回合立即取消等待；后来的同意不再生效', async () => {
    let resolve!: (reply: ApprovalReply) => void;
    const router = createApprovalRouter({
      ask: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const request = router.handle(SERVER_REQUEST.mcpServerElicitation, params);
    router.cancel((a) => a.threadId === 't');
    expect(await request).toEqual({ action: 'cancel', content: null, _meta: null });
    resolve({ decision: 'accept', optionId: 'always' });
    expect(router.pendingList()).toEqual([]);
  });
});
