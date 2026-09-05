/**
 * 自动化表单与历史（07）。
 *
 * 两组重点：**配置时就要说清的三件事**（关机不执行 / 绑定这台电脑 / 并发与重试定死），
 * 以及**跳过与漏跑不能混进失败**。后者混了的话，一个因为关机漏跑的任务
 * 看起来像"失败了 3 次"，用户会去查任务本身 —— 那里什么问题都没有。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  AutomationForm,
  AutomationHistory,
  describeRunStatus,
  FIXED_BEHAVIOR_NOTICE,
  MISFIRE_COPY,
  previewSchedule,
  summarizeRuns,
  type AutomationDraft,
  type RunRow,
} from '../src/renderer/views/automations.js';

const NOW = Date.parse('2026-09-05T02:00:00Z');

const DRAFT: AutomationDraft = {
  name: '每日周报',
  prompt: '整理本周进展',
  workspaces: ['/w/weekly'],
  schedule: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai',
  misfirePolicy: 'FIRE_ONCE_ON_WAKE',
  catchupWindowHours: 24,
  wakeSystem: false,
  budgetLimit: 50_000,
  testRun: true,
};

function Harness({ over = {} }: { over?: Partial<AutomationDraft> }) {
  const [draft, setDraft] = useState<AutomationDraft>({ ...DRAFT, ...over });
  return (
    <AutomationForm
      draft={draft}
      onChange={setDraft}
      deviceName="MacBook-Pro-J"
      workspaceOptions={[{ id: '/w/weekly', label: 'weekly' }]}
      now={NOW}
    />
  );
}

describe('**配置时就要说清的三件事**', () => {
  it('① 关机不执行 —— 常驻提示，不是事后解释（R9）', () => {
    render(<Harness />);
    expect(screen.getByText(/电脑关机或睡眠时不会执行/)).toBeTruthy();
  });

  it('② 绑定这台电脑，其他电脑看得见但不重复执行（Q15）', () => {
    render(<Harness />);
    expect(screen.getByText(/MacBook-Pro-J/)).toBeTruthy();
    expect(screen.getByText(/不会重复执行/)).toBeTruthy();
  });

  it('③ 并发与重试**不做成选项，但写明白**（Q8 / 07 §3.2）', () => {
    render(<Harness />);
    expect(screen.getByText(FIXED_BEHAVIOR_NOTICE)).toBeTruthy();
    // 不该出现"重试次数""并发策略"这类控件
    expect(screen.queryByText(/重试次数/)).toBeNull();
    expect(screen.queryByLabelText(/并发/)).toBeNull();
  });

  it('定时任务的预算是必填项，且说清为什么（07 §8-3）', () => {
    render(<Harness />);
    expect(screen.getByText(/没人在旁边看着的时候/)).toBeTruthy();
  });
});

describe('触发编辑器：三档递进（07 §3.3）', () => {
  it('三档都在，且**预览是三档共有的**', () => {
    render(<Harness />);
    for (const label of ['常用', '用说的', '高级']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(screen.getByText(/接下来 5 次/)).toBeTruthy();
  });

  it('**预览必须显示时区** —— 不显示时区的预览起不到防配错的作用', () => {
    render(<Harness />);
    expect(screen.getByText(/Asia\/Shanghai/)).toBeTruthy();
  });

  it('自然语言解析成功就改 cron，且回显人话', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: '用说的' }));
    fireEvent.change(screen.getByLabelText('用自然语言描述时间'), {
      target: { value: '每天晚上十点' },
    });
    expect(screen.getByText('每天 22:00')).toBeTruthy();
  });

  it('**认不出来是正常结果** —— 提示换说法，而不是报错', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: '用说的' }));
    fireEvent.change(screen.getByLabelText('用自然语言描述时间'), {
      target: { value: '等我想好了再说' },
    });
    expect(screen.getByText(/这句话我没看懂/)).toBeTruthy();
  });

  it('cron 写错时预览变成 danger 提示，而不是空白', () => {
    render(<Harness over={{ schedule: '0 25 * * *' }} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('previewSchedule 对永不触发的表达式给出具体原因', () => {
    const result = previewSchedule('0 0 30 2 *', 'UTC', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.reason).toContain('永远不会触发');
  });
});

describe('错过补偿的三个选项（07 §4.3）', () => {
  it('三项都有人话说明', () => {
    render(<Harness />);
    for (const policy of ['FIRE_ONCE_ON_WAKE', 'FIRE_ALL', 'DROP'] as const) {
      expect(screen.getByText(MISFIRE_COPY[policy].label)).toBeTruthy();
      expect(screen.getByText(MISFIRE_COPY[policy].hint)).toBeTruthy();
    }
  });

  it('选「逐次补齐」时额外警告可能连续执行多次', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/逐次补齐/));
    expect(screen.getByText(/连续执行多次并消耗较多额度/)).toBeTruthy();
  });

  it('补偿窗口写进说明里', () => {
    render(<Harness />);
    expect(screen.getByText(/只补最近 24 小时内错过的触发/)).toBeTruthy();
  });
});

describe('唤醒电脑（07 §4.4 / D5）', () => {
  it('默认关，且开启后**不承诺一定能唤醒**', () => {
    render(<Harness />);
    const toggle = screen.getByLabelText('允许唤醒这台电脑') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(screen.getByText(/合盖、断电或系统禁用唤醒时仍然不会执行/)).toBeTruthy();
  });
});

describe('**跳过与漏跑不是失败**（07 §5.1 / §5.2）', () => {
  const run = (over: Partial<RunRow>): RunRow => ({
    id: 'r1',
    fireTime: NOW,
    status: 'SUCCEEDED',
    trigger: 'SCHEDULED',
    ...over,
  });

  it('状态映射逐条对上 07 §5.2 的表', () => {
    expect(describeRunStatus(run({}))).toEqual({ badge: 'success', text: '成功' });
    expect(describeRunStatus(run({ status: 'FAILED', failureClass: 'MODEL' })).text).toBe(
      '失败 · 模型调用失败',
    );
    expect(describeRunStatus(run({ status: 'MISSED', skipReason: 'MACHINE_OFFLINE' }))).toEqual({
      badge: 'neutral',
      text: '漏跑 · 当时电脑关机或睡眠',
    });
    expect(describeRunStatus(run({ status: 'SKIPPED', skipReason: 'CONCURRENCY' }))).toEqual({
      badge: 'warning',
      text: '跳过 · 上一次还在执行中',
    });
  });

  it('**漏跑与跳过的 Badge 不是 danger** —— 它们不是失败', () => {
    expect(describeRunStatus(run({ status: 'MISSED' })).badge).not.toBe('danger');
    expect(describeRunStatus(run({ status: 'SKIPPED' })).badge).not.toBe('danger');
  });

  it('统计**四项分列**，漏跑不并进失败', () => {
    const stats = summarizeRuns([
      run({ id: '1' }),
      run({ id: '2', status: 'FAILED' }),
      run({ id: '3', status: 'MISSED' }),
      run({ id: '4', status: 'MISSED' }),
      run({ id: '5', status: 'SKIPPED' }),
    ]);
    expect(stats).toEqual({ succeeded: 1, failed: 1, skipped: 1, missed: 2 });
  });

  it('历史表头部显示四项统计', () => {
    render(
      <AutomationHistory
        name="每日周报"
        timezone="UTC"
        rows={[run({ id: '1' }), run({ id: '2', status: 'MISSED' })]}
      />,
    );
    expect(screen.getByText(/成功 1 · 失败 0 · 跳过 0 · 漏跑 1/)).toBeTruthy();
  });

  it('**补跑那条要标注原定时刻**，否则看不出它是补的（07 §8-1）', () => {
    render(
      <AutomationHistory
        name="每日周报"
        timezone="UTC"
        rows={[run({ id: '1', trigger: 'CATCHUP', originalFireTime: NOW - 86_400_000 })]}
      />,
    );
    expect(screen.getByText(/补跑（原定/)).toBeTruthy();
  });

  it('自动暂停时给出恢复入口，并说清怎么办（Q8）', () => {
    const onResume = vi.fn();
    render(
      <AutomationHistory name="每日周报" timezone="UTC" rows={[]} paused onResume={onResume} />,
    );
    expect(screen.getByText(/连续失败 3 次后已自动暂停/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(onResume).toHaveBeenCalled();
  });

  it('没跑过时的空态给出下一步', () => {
    render(<AutomationHistory name="x" timezone="UTC" rows={[]} />);
    expect(screen.getByText('还没有执行过')).toBeTruthy();
    expect(screen.queryByText(/暂无/)).toBeNull();
  });
});
