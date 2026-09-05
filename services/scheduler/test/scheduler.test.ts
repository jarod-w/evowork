/**
 * misfire 补偿 · 失败语义 · 设备绑定 · 自然语言解析（M5）。
 *
 * 最重要的一组是「补偿的落库顺序」：07 §8-1 要求历史里出现**两条**记录
 * （错过 + 补跑）。只留补跑那一条的话，用户永远不知道自己漏了 ——
 * 而这决定的是 scheduler 的写库顺序，不只是 UI 文案。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyFailure,
  applySuccess,
  bindingNotice,
  classifyFailure,
  CONSECUTIVE_FAILURE_LIMIT,
  countsTowardPause,
  createScheduler,
  describeCron,
  describeRun,
  migrate,
  missedFireTimes,
  OFFLINE_EXPECTATION_NOTICE,
  parseNaturalSchedule,
  parseTimeOfDay,
  planMisfire,
  scanWindow,
  shouldSuggestMigration,
  type AutomationDefinition,
  type RunRecord,
} from '../src/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string): number => Date.parse(iso);

const BASE_MISFIRE = {
  schedule: '0 9 * * *',
  timezone: 'UTC',
  catchupWindowMs: DAY,
  policy: 'FIRE_ONCE_ON_WAKE' as const,
};

describe('扫描窗口（总纲 §6.9：[max(last_fire, now - catchup_window), now]）', () => {
  it('从未触发过时按补偿窗口起算', () => {
    const now = at('2026-06-10T12:00:00Z');
    expect(scanWindow({ ...BASE_MISFIRE, now }).from).toBe(now - DAY);
  });

  it('上次触发晚于窗口起点时从上次触发起算（不会重复补跑已跑过的）', () => {
    const now = at('2026-06-10T12:00:00Z');
    const lastFireTime = now - 2 * HOUR;
    expect(scanWindow({ ...BASE_MISFIRE, now, lastFireTime }).from).toBe(lastFireTime);
  });
});

describe('**补偿的落库顺序**：先写 MISSED，再补跑（07 §8-1）', () => {
  // 关机 3 天，每天 09:00 的任务；补偿窗口 24h 只覆盖最近 1 次
  const now = at('2026-06-10T12:00:00Z');

  it('窗口内错过 1 次：FIRE_ONCE_ON_WAKE 产出「一条 MISSED + 一条补跑」', () => {
    const plan = planMisfire({ ...BASE_MISFIRE, now });
    expect(plan).toHaveLength(2);
    expect(plan[0]?.status).toBe('MISSED');
    expect(plan[0]?.skipReason).toBe('MACHINE_OFFLINE');
    expect(plan[1]?.status).toBe('PENDING_RUN');
    expect(plan[1]?.trigger).toBe('CATCHUP');
    // 补跑那条要指向原定时刻，否则历史上显示不出"原定 09:00"
    expect(plan[1]?.originalFireTime).toBe(at('2026-06-10T09:00:00Z'));
  });

  it('窗口内错过多次：**只补最近一次**，但每一次都记 MISSED', () => {
    const plan = planMisfire({
      ...BASE_MISFIRE,
      schedule: '0 * * * *', // 每小时
      now,
      catchupWindowMs: 5 * HOUR,
    });
    const missed = plan.filter((a) => a.status === 'MISSED');
    const runs = plan.filter((a) => a.status === 'PENDING_RUN');
    expect(missed.length).toBeGreaterThan(1);
    expect(runs).toHaveLength(1);
    // 补的是最近的那一次
    expect(runs[0]?.originalFireTime).toBe(missed[missed.length - 1]?.fireTime);
  });

  it('FIRE_ALL：每一次都补，**且每一次都先记一条 MISSED**', () => {
    const plan = planMisfire({
      ...BASE_MISFIRE,
      schedule: '0 * * * *',
      policy: 'FIRE_ALL',
      now,
      catchupWindowMs: 3 * HOUR,
    });
    expect(plan.filter((a) => a.status === 'MISSED').length).toBe(
      plan.filter((a) => a.status === 'PENDING_RUN').length,
    );
    // 顺序：MISSED 紧接着它的补跑
    expect(plan[0]?.status).toBe('MISSED');
    expect(plan[1]?.status).toBe('PENDING_RUN');
  });

  it('DROP：全部记 MISSED，**一次都不跑**', () => {
    const plan = planMisfire({ ...BASE_MISFIRE, policy: 'DROP', now });
    expect(plan.every((a) => a.status === 'MISSED')).toBe(true);
  });

  it('补偿窗口之外的错过不进计划（关机一周不会补一周）', () => {
    const times = missedFireTimes({ ...BASE_MISFIRE, now, catchupWindowMs: DAY });
    expect(times.every((t) => t >= now - DAY)).toBe(true);
  });

  it('生效期之外的触发不补', () => {
    const plan = planMisfire({ ...BASE_MISFIRE, now, validFrom: now });
    expect(plan).toHaveLength(0);
  });
});

describe('历史条目的文案与计划一一对应（07 §5）', () => {
  const formatTime = (at_: number) => new Date(at_).toISOString().slice(11, 16);

  it('错过写"电脑当时未开机"，不是泛泛的"失败"', () => {
    expect(
      describeRun({
        status: 'MISSED',
        trigger: 'SCHEDULED',
        skipReason: 'MACHINE_OFFLINE',
        formatTime,
      }),
    ).toContain('未开机');
  });

  it('补跑要标注原定时刻', () => {
    expect(
      describeRun({
        status: 'SUCCEEDED',
        trigger: 'CATCHUP',
        originalFireTime: at('2026-06-10T09:00:00Z'),
        formatTime,
      }),
    ).toBe('补跑（原定 09:00）');
  });

  it('并发跳过说清是"上一次还没跑完"', () => {
    expect(
      describeRun({
        status: 'SKIPPED',
        trigger: 'SCHEDULED',
        skipReason: 'CONCURRENCY',
        formatTime,
      }),
    ).toContain('上一次还没跑完');
  });
});

describe('**环境原因失败不计数**（07 §8-2）', () => {
  it('三类任务自身失败才计数', () => {
    expect(countsTowardPause('MODEL')).toBe(true);
    expect(countsTowardPause('SCRIPT')).toBe(true);
    expect(countsTowardPause('APPROVAL_TIMEOUT')).toBe(true);
    expect(countsTowardPause('ENVIRONMENT')).toBe(false);
    expect(countsTowardPause('QUOTA')).toBe(false);
  });

  it('笔记本关机导致的失败不会让自动化在三天内被全部暂停', () => {
    let count = 0;
    for (let day = 0; day < 10; day += 1) {
      count = applyFailure(count, 'ENVIRONMENT', 'x').consecutiveFailures;
    }
    expect(count).toBe(0);
  });

  it('环境失败**不清零** —— 清零会让"每次失败之间夹一次关机"变成永不暂停', () => {
    let count = applyFailure(0, 'MODEL', 'x').consecutiveFailures;
    count = applyFailure(count, 'ENVIRONMENT', 'x').consecutiveFailures;
    expect(count).toBe(1);
  });

  it('连续 3 次自动暂停，且通知**说清怎么恢复**（Q8）', () => {
    let outcome = applyFailure(0, 'MODEL', '每日周报');
    outcome = applyFailure(outcome.consecutiveFailures, 'SCRIPT', '每日周报');
    expect(outcome.shouldPause).toBe(false);
    outcome = applyFailure(outcome.consecutiveFailures, 'MODEL', '每日周报');
    expect(outcome.consecutiveFailures).toBe(CONSECUTIVE_FAILURE_LIMIT);
    expect(outcome.shouldPause).toBe(true);
    expect(outcome.notice).toContain('每日周报');
    expect(outcome.notice).toContain('恢复');
  });

  it('成功清零', () => {
    expect(applySuccess().consecutiveFailures).toBe(0);
  });

  it('分不出来时归到计数的那一侧（猜成不计数等于让真实故障永不暂停）', () => {
    expect(classifyFailure({})).toBe('SCRIPT');
    expect(classifyFailure({ workspaceMissing: true })).toBe('ENVIRONMENT');
    expect(classifyFailure({ approvalTimedOut: true })).toBe('APPROVAL_TIMEOUT');
    expect(classifyFailure({ budgetExceeded: true })).toBe('QUOTA');
    expect(classifyFailure({ modelErrorCode: 'rate_limit_exceeded' })).toBe('MODEL');
  });
});

describe('设备绑定与迁移（Q15）', () => {
  const binding = {
    automationId: 'a1',
    deviceId: 'laptop',
    workspaces: ['/Users/li/work'],
    lastFireTime: at('2026-06-01T09:00:00Z'),
    revision: 3,
  };
  const now = at('2026-06-10T12:00:00Z');

  it('**迁移把 misfire 基准重置为迁移时刻** —— 否则新机器一上线就补一堆历史触发', () => {
    const result = migrate({
      binding,
      targetDeviceId: 'desktop',
      at: now,
      workspaceExists: () => true,
      remoteRevision: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('类型收窄');
    expect(result.lastFireTime).toBe(now);
    expect(result.deviceId).toBe('desktop');
    expect(result.revision).toBe(4);
  });

  it('工作空间不存在时**迁移必须失败**，不静默改路径', () => {
    const result = migrate({
      binding,
      targetDeviceId: 'desktop',
      at: now,
      workspaceExists: () => false,
      remoteRevision: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.code).toBe('WORKSPACE_MISSING');
    expect(result.message).toContain('不会替你换');
  });

  it('乐观锁：另一台机器先动了就冲突', () => {
    const result = migrate({
      binding,
      targetDeviceId: 'desktop',
      at: now,
      workspaceExists: () => true,
      remoteRevision: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.code).toBe('CONFLICT');
  });

  it('离线超 7 天才提示迁移，且只对非绑定设备提示', () => {
    expect(
      shouldSuggestMigration({ boundDeviceLastSeen: now - 8 * DAY, now, isBoundDevice: false }),
    ).toBe(true);
    expect(
      shouldSuggestMigration({ boundDeviceLastSeen: now - 8 * DAY, now, isBoundDevice: true }),
    ).toBe(false);
    expect(
      shouldSuggestMigration({ boundDeviceLastSeen: now - 3 * DAY, now, isBoundDevice: false }),
    ).toBe(false);
  });

  it('两条预期管理文案：绑定说明与关机说明（07 §4.1 / §4.2）', () => {
    expect(bindingNotice('MacBook-Pro-J')).toContain('不会重复执行');
    // **配置时**就要说，不能只在事后解释（R9）
    expect(OFFLINE_EXPECTATION_NOTICE).toContain('关机或睡眠时不会执行');
  });
});

describe('调度循环', () => {
  const automation: AutomationDefinition = {
    id: 'a1',
    name: '每日周报',
    prompt: '把本周的进展整理成一份周报',
    deviceId: 'laptop',
    schedule: '0 9 * * *',
    timezone: 'UTC',
    status: 'ACTIVE',
    misfirePolicy: 'FIRE_ONCE_ON_WAKE',
    catchupWindowMs: DAY,
    consecutiveFailures: 0,
    budgetLimit: 100_000,
    workspaces: ['/w'],
  };

  function ports(over: Partial<Parameters<typeof createScheduler>[0]> = {}) {
    const runs: RunRecord[] = [];
    const patches: unknown[] = [];
    const notices: string[] = [];
    const base = {
      now: () => at('2026-06-10T12:00:00Z'),
      insertRun: (record: RunRecord) => {
        if (
          runs.some(
            (r) =>
              r.automationId === record.automationId &&
              r.fireTime === record.fireTime &&
              r.status !== 'MISSED',
          )
        ) {
          return false;
        }
        runs.push(record);
        return true;
      },
      updateAutomation: (_id: string, patch: unknown) => patches.push(patch),
      startRun: async () => 'thread-1',
      isRunning: () => false,
      notify: (text: string) => notices.push(text),
      deviceId: 'laptop',
      ...over,
    };
    return { ports: base, runs, patches, notices };
  }

  it('**非绑定设备不触发**（Q15：其他电脑只读）', async () => {
    const { ports: p } = ports({ deviceId: 'desktop' });
    const scheduler = createScheduler(p);
    expect(scheduler.scanOnStart(automation)).toHaveLength(0);
    expect((await scheduler.fire(automation, at('2026-06-10T09:00:00Z'))).reason).toBe(
      'NOT_THIS_DEVICE',
    );
  });

  it('暂停的自动化不按计划触发，但可以手动跑', async () => {
    const { ports: p } = ports();
    const scheduler = createScheduler(p);
    const paused = { ...automation, status: 'PAUSED' as const };
    expect((await scheduler.fire(paused, 1)).reason).toBe('PAUSED');
    expect((await scheduler.fire(paused, at('2026-06-10T09:00:00Z'), 'MANUAL')).fired).toBe(true);
  });

  it('**上一次没跑完 → SKIP 并落一条记录**（Q8，用户要能看到被跳过了）', async () => {
    const { ports: p, runs } = ports({ isRunning: () => true });
    const outcome = await createScheduler(p).fire(automation, at('2026-06-10T09:00:00Z'));
    expect(outcome.reason).toBe('CONCURRENCY');
    expect(runs[0]?.status).toBe('SKIPPED');
    expect(runs[0]?.skipReason).toBe('CONCURRENCY');
  });

  it('幂等键冲突直接跳过（单机不需要分布式锁）', async () => {
    const { ports: p } = ports();
    const scheduler = createScheduler(p);
    const fireTime = at('2026-06-10T09:00:00Z');
    expect((await scheduler.fire(automation, fireTime)).fired).toBe(true);
    expect((await scheduler.fire(automation, fireTime)).reason).toBe('DUPLICATE');
  });

  it('生效期之外记 OUT_OF_WINDOW', async () => {
    const { ports: p, runs } = ports();
    const outcome = await createScheduler(p).fire(
      { ...automation, validUntil: at('2026-01-01T00:00:00Z') },
      at('2026-06-10T09:00:00Z'),
    );
    expect(outcome.reason).toBe('OUT_OF_WINDOW');
    expect(runs[0]?.skipReason).toBe('OUT_OF_WINDOW');
  });

  it('misfire 计划按序落库：MISSED 在补跑之前', async () => {
    const { ports: p, runs } = ports();
    const scheduler = createScheduler(p);
    const plan = scheduler.scanOnStart(automation);
    await scheduler.applyMisfirePlan(automation, plan);

    expect(runs[0]?.status).toBe('MISSED');
    expect(runs[1]?.status).toBe('RUNNING');
    expect(runs[1]?.trigger).toBe('CATCHUP');
    expect(runs[1]?.originalFireTime).toBe(at('2026-06-10T09:00:00Z'));
  });

  it('连续失败到上限时置 PAUSED 并通知', () => {
    const { ports: p, patches, notices } = ports();
    createScheduler(p).complete(
      { ...automation, consecutiveFailures: 2 },
      { ok: false, failureClass: 'MODEL' },
    );
    expect(patches[0]).toMatchObject({ status: 'PAUSED', consecutiveFailures: 3 });
    expect(notices[0]).toContain('已自动暂停');
  });

  it('nextWakeup 对暂停与非本机返回 undefined', () => {
    const { ports: p } = ports();
    const scheduler = createScheduler(p);
    expect(scheduler.nextWakeup(automation)).toBe(at('2026-06-11T09:00:00Z'));
    expect(scheduler.nextWakeup({ ...automation, status: 'PAUSED' })).toBeUndefined();
    expect(scheduler.nextWakeup({ ...automation, deviceId: 'other' })).toBeUndefined();
  });

  it('startRun 拿到的是定义与触发时刻（预算随定义带过去）', async () => {
    const startRun = vi.fn(async () => 'thread-9');
    const { ports: p } = ports({ startRun });
    await createScheduler(p).fire(automation, at('2026-06-10T09:00:00Z'));
    expect(startRun).toHaveBeenCalledWith(automation, at('2026-06-10T09:00:00Z'));
    expect(automation.budgetLimit).toBeGreaterThan(0);
  });
});

describe('自然语言解析（07 §3.3 第 ② 档，**不调模型**）', () => {
  it('工作日 / 每周 / 每月 / 每天', () => {
    expect(parseNaturalSchedule('每个工作日下午六点')?.cron).toBe('0 18 * * 1-5');
    expect(parseNaturalSchedule('每周一 9:30')?.cron).toBe('30 9 * * 1');
    expect(parseNaturalSchedule('每月 15 号早上八点')?.cron).toBe('0 8 15 * *');
    expect(parseNaturalSchedule('每天晚上十点')?.cron).toBe('0 22 * * *');
  });

  it('多个星期几', () => {
    expect(parseNaturalSchedule('每周一、周三、周五 18:00')?.cron).toBe('0 18 * * 1,3,5');
  });

  it('每 N 小时 / 每 N 分钟', () => {
    expect(parseNaturalSchedule('每 2 小时')?.cron).toBe('0 */2 * * *');
    expect(parseNaturalSchedule('每三十分钟')?.cron).toBe('*/30 * * * *');
  });

  it('「下午 18 点」不会变成 30 点', () => {
    expect(parseTimeOfDay('下午 18 点')).toEqual({ hour: 18, minute: 0 });
    expect(parseTimeOfDay('下午六点半')).toEqual({ hour: 18, minute: 30 });
  });

  it('**认不出来是正常结果**，返回 undefined 让 UI 回落到常用档', () => {
    expect(parseNaturalSchedule('等我想好了再说')).toBeUndefined();
    expect(parseNaturalSchedule('')).toBeUndefined();
  });

  it('只说时间没说频率 → 按每天算，但**回显里说清这个假设**', () => {
    const parsed = parseNaturalSchedule('晚上十一点');
    expect(parsed?.cron).toBe('0 23 * * *');
    expect(parsed?.description).toContain('没说频率');
  });

  it('回显是人话不是 cron（用户要确认的是这句）', () => {
    expect(parseNaturalSchedule('每个工作日下午六点')?.description).toBe('每周一至周五 18:00');
    expect(describeCron('0 18 * * 1-5')).toBe('每周一至周五 18:00');
    expect(describeCron('30 9 * * 1,3')).toContain('一、周三');
    expect(describeCron('0 8 15 * *')).toBe('每月 15 号 08:00');
  });
});
