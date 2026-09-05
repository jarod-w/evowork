import type { Thread, ThreadStatus } from '@evowork/protocol';
import { describe, expect, it } from 'vitest';

import { deriveStatus, STATUS_LABEL } from '../src/derive-status.js';
import { DERIVED_STATUS } from '../src/schema.js';
import { openStore, type Store } from '../src/store.js';

const ACTIVE: ThreadStatus = { active: { activeFlags: [] } };
const WAITING_APPROVAL: ThreadStatus = { active: { activeFlags: ['waitingOnApproval'] } };
const WAITING_INPUT: ThreadStatus = { active: { activeFlags: ['waitingOnUserInput'] } };

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    sessionId: 's1',
    preview: '把 data/ 下的三张表合并',
    ephemeral: false,
    modelProvider: 'evowork',
    model: 'deepseek-chat',
    createdAt: 1_757_000_000,
    updatedAt: 1_757_000_100,
    recencyAt: 1_757_000_100,
    status: 'idle',
    cwd: '/Users/x/work/weekly',
    turns: [],
    ...over,
  };
}

function withStore(fn: (store: Store) => void): void {
  const store = openStore({ path: ':memory:' });
  try {
    fn(store);
  } finally {
    store.close();
  }
}

describe('deriveStatus —— 清单六态 + 已中断（04 §2.2）', () => {
  it('内核的 ThreadStatus 单独**推不出**已完成 / 失败 / 已中断（F7 的直接后果）', () => {
    // 只有实时状态、没有投影记录时，只能得出"还没开始"
    expect(deriveStatus({ threadStatus: 'idle' })).toBe('idle');
    // 加上投影表记的上一个回合结果，三个终态才出得来
    expect(deriveStatus({ threadStatus: 'idle', lastTurnStatus: 'completed' })).toBe('completed');
    expect(deriveStatus({ threadStatus: 'idle', lastTurnStatus: 'failed' })).toBe('failed');
    expect(deriveStatus({ threadStatus: 'idle', lastTurnStatus: 'interrupted' })).toBe(
      'interrupted',
    );
  });

  it('未加载的历史任务恒为 notLoaded，此时结论只能来自投影表', () => {
    expect(deriveStatus({ threadStatus: 'notLoaded', lastTurnStatus: 'completed' })).toBe(
      'completed',
    );
    expect(deriveStatus({ threadStatus: 'notLoaded' })).toBe('idle');
  });

  it('「待处理」优先于「进行中」—— 它是唯一需要用户立刻行动的状态', () => {
    expect(deriveStatus({ threadStatus: ACTIVE })).toBe('running');
    expect(deriveStatus({ threadStatus: WAITING_APPROVAL })).toBe('pending');
    expect(deriveStatus({ threadStatus: WAITING_INPUT })).toBe('pending');
    // 即使投影表记着上次完成过，正在等审批仍然是 pending
    expect(deriveStatus({ threadStatus: WAITING_APPROVAL, lastTurnStatus: 'completed' })).toBe(
      'pending',
    );
  });

  it('归档优先于一切 —— 用户的动作优先于系统状态', () => {
    expect(deriveStatus({ threadStatus: WAITING_APPROVAL, archived: true })).toBe('archived');
  });

  it('systemError → 失败', () => {
    expect(deriveStatus({ threadStatus: 'systemError' })).toBe('failed');
  });

  it('规划中：plan 模式 + 有计划 + 未确认', () => {
    const base = { threadStatus: 'idle' as ThreadStatus, modeId: 'plan', hasPlanItem: true };
    expect(deriveStatus(base)).toBe('planning');
    expect(deriveStatus({ ...base, planConfirmed: true })).toBe('idle');
    // craft 模式即使有计划也不是"规划中"
    expect(deriveStatus({ ...base, modeId: 'craft' })).toBe('idle');
    // 没有计划时也不是
    expect(deriveStatus({ ...base, hasPlanItem: false })).toBe('idle');
  });

  it('规划中必须**优先于** last_turn_status —— 否则它永远不会出现', () => {
    // 产出计划的那个回合本身是 completed；若先看 last_turn_status 就会报"已完成"
    expect(
      deriveStatus({
        threadStatus: 'idle',
        lastTurnStatus: 'completed',
        modeId: 'plan',
        hasPlanItem: true,
        planConfirmed: false,
      }),
    ).toBe('planning');
  });

  it('投影表说 inProgress 但内核说不 active → 已中断（内核重启过），不报"进行中"', () => {
    expect(deriveStatus({ threadStatus: 'idle', lastTurnStatus: 'inProgress' })).toBe(
      'interrupted',
    );
  });

  it('每个状态都有文案，且「待你确认」用第二人称（01 §6.1）', () => {
    for (const status of DERIVED_STATUS) {
      expect(STATUS_LABEL[status]).toBeTruthy();
    }
    expect(STATUS_LABEL.pending).toBe('待你确认');
    expect(STATUS_LABEL.interrupted).toContain('可继续');
  });
});

describe('ThreadProjection —— 权威性规则（09 §4.1）', () => {
  it('upsertFromThread 写入内核权威字段 + 派生状态', () => {
    withStore((store) => {
      const derived = store.threads.upsertFromThread(
        thread({ name: '季度汇报 PPT', status: ACTIVE }),
        { scenarioId: 'office', modeId: 'craft', permissionId: 'evowork-workspace' },
      );
      expect(derived).toBe('running');

      const row = store.threads.get('t1');
      expect(row?.title).toBe('季度汇报 PPT');
      expect(row?.cwd).toBe('/Users/x/work/weekly');
      expect(row?.scenario_id).toBe('office');
      expect(row?.mode_id).toBe('craft');
      expect(row?.derived_status).toBe('running');
      // 内核给的是**秒**，我们统一存毫秒
      expect(row?.created_at).toBe(1_757_000_000_000);
    });
  });

  it('重复 upsert 不覆盖 EvoWork 自己的字段（否则对账会冲掉用户改过的模式）', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread(), { scenarioId: 'office', modeId: 'craft' });
      // 用户在任务里把模式改成了 plan
      store.threads.setTaskSettings('t1', { modeId: 'plan', budgetLimit: 200_000 });
      // 一次对账（不带 origin）
      store.threads.upsertFromThread(thread({ name: '新标题' }));

      const row = store.threads.get('t1');
      expect(row?.title).toBe('新标题'); // 内核权威字段被更新
      expect(row?.mode_id).toBe('plan'); // EvoWork 字段保留
      expect(row?.budget_limit).toBe(200_000);
    });
  });

  it('applyTurnCompleted 是三个终态**唯一的来源**', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread({ status: ACTIVE }));
      expect(store.threads.get('t1')?.derived_status).toBe('running');

      expect(store.threads.applyTurnCompleted('t1', { id: 'turn1', status: 'interrupted' })).toBe(
        'interrupted',
      );
      const row = store.threads.get('t1');
      expect(row?.last_turn_status).toBe('interrupted');
      expect(row?.last_turn_id).toBe('turn1');
    });
  });

  it('applyStatusChanged 在 pending / running 之间正确切换', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread({ status: ACTIVE }));
      expect(store.threads.applyStatusChanged('t1', WAITING_APPROVAL)).toBe('pending');
      expect(store.threads.applyStatusChanged('t1', ACTIVE)).toBe('running');
      // 回到 idle 时，用投影表记着的 last_turn_status 得出终态
      store.threads.applyTurnCompleted('t1', { id: 'turn1', status: 'completed' });
      expect(store.threads.applyStatusChanged('t1', 'idle')).toBe('completed');
    });
  });

  it('plan → 确认执行 的状态流转', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread(), { modeId: 'plan' });
      expect(store.threads.applyPlanUpdated('t1', true)).toBe('planning');
      store.threads.markPlanConfirmed('t1');
      expect(store.threads.applyStatusChanged('t1', ACTIVE)).toBe('running');
    });
  });

  it('token 用量累计（预算闸门与用量条的数据源，10 §5.2）', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread());
      store.threads.applyTokenUsage('t1', {
        total: { inputTokens: 2143, outputTokens: 1877, cachedInputTokens: 0 },
        last: { inputTokens: 100 },
      });
      const row = store.threads.get('t1');
      expect(row?.token_input).toBe(2143);
      expect(row?.token_output).toBe(1877);
      expect(row?.token_cached).toBe(0);
    });
  });

  it('归档与取消归档', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread());
      store.threads.applyTurnCompleted('t1', { id: 'turn1', status: 'completed' });
      expect(store.threads.setArchived('t1', true)).toBe('archived');
      expect(store.threads.setArchived('t1', false)).toBe('completed');
    });
  });
});

describe('queryThreadIds —— 投影表存在的主要理由（04 §3.4）', () => {
  function seed(store: Store): void {
    const rows: [string, string, number, string, number][] = [
      // id, derived, updated_at(ms), cwd, artifact_count
      ['t-run', 'running', 1_757_000_500_000, '/w/a', 0],
      ['t-pend', 'pending', 1_757_000_400_000, '/w/a', 0],
      ['t-done', 'completed', 1_757_000_300_000, '/w/b', 2],
      ['t-fail', 'failed', 1_757_000_200_000, '/w/b', 0],
      ['t-intr', 'interrupted', 1_757_000_100_000, '/w/a', 1],
      ['t-arch', 'archived', 1_757_000_000_000, '/w/a', 0],
    ];
    for (const [id, derived, updated, cwd, artifacts] of rows) {
      store.db
        .prepare(
          `INSERT INTO thread_projection(thread_id, derived_status, updated_at, recency_at, cwd,
             artifact_count, archived)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(id, derived, updated, updated, cwd, artifacts, derived === 'archived' ? 1 : 0);
    }
  }

  it('按状态多选筛选 —— 内核完全不支持这件事（F8）', () => {
    withStore((store) => {
      seed(store);
      expect(store.threads.queryThreadIds({ statuses: ['running', 'pending'] })).toEqual([
        't-run',
        't-pend',
      ]);
      expect(store.threads.queryThreadIds({ statuses: ['failed'] })).toEqual(['t-fail']);
    });
  });

  it('按时间范围筛选 —— 同样是内核不支持的（F8）', () => {
    withStore((store) => {
      seed(store);
      const ids = store.threads.queryThreadIds({ updatedAfter: 1_757_000_300_000 });
      expect(ids).toEqual(['t-run', 't-pend', 't-done']);
      expect(
        store.threads.queryThreadIds({
          updatedAfter: 1_757_000_200_000,
          updatedBefore: 1_757_000_300_000,
        }),
      ).toEqual(['t-done', 't-fail']);
    });
  });

  it('默认不带归档（归档的入口在「更多 → 数据管理」，02 §4.7）', () => {
    withStore((store) => {
      seed(store);
      expect(store.threads.queryThreadIds()).not.toContain('t-arch');
      expect(store.threads.queryThreadIds({ archived: true })).toEqual(['t-arch']);
    });
  });

  it('按工作空间与「是否有产物」筛选', () => {
    withStore((store) => {
      seed(store);
      expect(store.threads.queryThreadIds({ cwd: '/w/b' })).toEqual(['t-done', 't-fail']);
      expect(store.threads.queryThreadIds({ hasArtifact: true })).toEqual(['t-done', 't-intr']);
    });
  });

  it('子任务不出现在顶层列表（04 §3.2）', () => {
    withStore((store) => {
      store.threads.upsertFromThread(thread({ id: 'parent' }));
      store.threads.upsertFromThread(thread({ id: 'child', parentThreadId: 'parent' }));
      expect(store.threads.queryThreadIds({ topLevelOnly: true })).toEqual(['parent']);
      expect(store.threads.queryThreadIds()).toHaveLength(2);
    });
  });

  it('按 recency 倒序 —— 与侧边栏默认排序一致', () => {
    withStore((store) => {
      seed(store);
      expect(store.threads.queryThreadIds({ limit: 3 })).toEqual(['t-run', 't-pend', 't-done']);
    });
  });

  it('筛选生效时给出「12 / 148」需要的两个数（04 §3.4）', () => {
    withStore((store) => {
      seed(store);
      expect(store.threads.count({ statuses: ['running', 'pending'] })).toBe(2);
      expect(store.threads.count()).toBe(5); // 不含归档
      expect(store.threads.countByStatus()).toMatchObject({ running: 1, pending: 1, completed: 1 });
    });
  });

  it('idsNotIn 支持对账：投影表里有、内核已经没有的（09 §4.1）', () => {
    withStore((store) => {
      seed(store);
      expect(store.threads.idsNotIn(['t-run', 't-pend', 't-done', 't-fail', 't-intr'])).toEqual([
        't-arch',
      ]);
    });
  });

  it('**只返回 id**，逼调用方走第 ② 步去拉权威字段（避免用过期 title 渲染）', () => {
    withStore((store) => {
      seed(store);
      const ids = store.threads.queryThreadIds({ statuses: ['running'] });
      expect(ids).toEqual(['t-run']);
      expect(typeof ids[0]).toBe('string');
    });
  });
});

describe('排序稳定性', () => {
  it('同一时间戳的任务按 thread_id 兜底排序 —— 否则列表会在两次渲染之间跳动', () => {
    withStore((store) => {
      for (const id of ['t-c', 't-a', 't-b']) {
        store.db
          .prepare(
            `INSERT INTO thread_projection(thread_id, derived_status, updated_at, recency_at)
             VALUES(?,?,?,?)`,
          )
          .run(id, 'completed', 1000, 1000);
      }
      const first = store.threads.queryThreadIds();
      const second = store.threads.queryThreadIds();
      expect(first).toEqual(['t-a', 't-b', 't-c']);
      expect(second).toEqual(first);
    });
  });
});
