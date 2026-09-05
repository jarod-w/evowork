/**
 * cron 与时区（07 §3.2 / §3.3）。
 *
 * 三组断言，重要性递增：字段语义 → 时区显式 → **DST 的两个边界**。
 * 最后一组是这个文件存在的主要理由：DST 出错的表现是"一年里有一天没跑"或"跑了两次"，
 * 而它一年只发生两次，靠用户反馈发现要等半年。
 */
import { describe, expect, it } from 'vitest';

import {
  CronParseError,
  fromLocalParts,
  nextFire,
  nextFireTime,
  parseCron,
  parseSchedule,
  toLocalParts,
  upcomingFireTimes,
} from '../src/cron.js';

const SHANGHAI = 'Asia/Shanghai';
const NEW_YORK = 'America/New_York';

function at(iso: string): number {
  return Date.parse(iso);
}

function localOf(instant: number, zone: string): string {
  const p = toLocalParts(instant, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

describe('字段解析', () => {
  it('五个字段，少了给出例子而不是只说"格式错误"', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronParseError);
    expect(() => parseCron('0 9 * *')).toThrow(/工作日早 9 点/);
  });

  it('范围、步长、列表、月份名与星期名', () => {
    expect(parseCron('0 9 * * 1-5').daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9,18 * * *').hours).toEqual([9, 18]);
    expect(parseCron('0 0 1 jan *').months).toEqual([1]);
    expect(parseCron('0 0 * * mon').daysOfWeek).toEqual([1]);
  });

  it('**7 与 0 都是周日** —— 认错的表现是"周日不跑"', () => {
    expect(parseCron('0 9 * * 7').daysOfWeek).toEqual([0]);
    expect(parseCron('0 9 * * 0').daysOfWeek).toEqual([0]);
  });

  it('超范围的值被拒', () => {
    expect(() => parseCron('0 25 * * *')).toThrow();
    expect(() => parseCron('0 9 32 * *')).toThrow();
  });
});

describe('**日与周同时限定时是 OR 不是 AND**（几乎所有人第一次都写错）', () => {
  it('"每月 1 号或每周一"两者都触发', () => {
    const fields = parseCron('0 0 1 * 1');
    // 2026-06-01 是周一；2026-06-08 是周一（非 1 号）；2026-07-01 是周三（1 号）
    const times = upcomingFireTimes(fields, at('2026-06-01T00:00:00Z'), 'UTC', 3);
    expect(times.map((t) => localOf(t, 'UTC'))).toEqual([
      '2026-06-08 00:00',
      '2026-06-15 00:00',
      '2026-06-22 00:00',
    ]);
  });

  it('只限定日时按日走', () => {
    const times = upcomingFireTimes(parseCron('0 0 15 * *'), at('2026-06-01T00:00:00Z'), 'UTC', 2);
    expect(times.map((t) => localOf(t, 'UTC'))).toEqual(['2026-06-15 00:00', '2026-07-15 00:00']);
  });
});

describe('**时区是显式的**（07 §3.2：跨时区出差不改变触发时刻）', () => {
  it('同一个 cron 在两个时区给出不同的 UTC 时刻', () => {
    const fields = parseCron('0 9 * * *');
    const base = at('2026-06-10T00:00:00Z');
    const shanghai = nextFireTime(fields, base, SHANGHAI) as number;
    const newYork = nextFireTime(fields, base, NEW_YORK) as number;

    expect(localOf(shanghai, SHANGHAI)).toBe('2026-06-10 09:00');
    expect(localOf(newYork, NEW_YORK)).toBe('2026-06-10 09:00');
    expect(shanghai).not.toBe(newYork);
  });

  it('本地字段 → 时刻 → 本地字段能往返', () => {
    const instant = fromLocalParts(
      { year: 2026, month: 3, day: 15, hour: 14, minute: 30 },
      NEW_YORK,
    );
    expect(localOf(instant, NEW_YORK)).toBe('2026-03-15 14:30');
  });

  it('午夜不会被 Intl 的 "24" 弄错', () => {
    const midnight = nextFireTime(
      parseCron('0 0 * * *'),
      at('2026-06-10T05:00:00Z'),
      SHANGHAI,
    ) as number;
    expect(localOf(midnight, SHANGHAI)).toBe('2026-06-11 00:00');
  });
});

describe('**DST 的两个边界** —— 一年只发生两次，错了半年才有人报', () => {
  it('春季跳过：那天没有 02:30 → **在跳变后的第一个瞬间触发**，而不是跳过这一天', () => {
    // 2026-03-08 美东 02:00 → 03:00
    const fields = parseCron('30 2 * * *');
    const fire = nextFireTime(fields, at('2026-03-07T12:00:00Z'), NEW_YORK) as number;
    const local = toLocalParts(fire, NEW_YORK);

    expect(local.day, '不能跳过 3 月 8 日这一天').toBe(8);
    // 02:30 不存在 → 落到跳变后的第一个瞬间 03:00（不是次日，也不是回退到 01:30）
    expect(`${local.hour}:${String(local.minute).padStart(2, '0')}`).toBe('3:00');
  });

  it('秋季重复：02:30 出现两次 → **只触发一次**', () => {
    // 2026-11-01 美东 02:00 回拨到 01:00
    const fields = parseCron('30 1 * * *');
    const times = upcomingFireTimes(fields, at('2026-10-31T12:00:00Z'), NEW_YORK, 3);
    const days = times.map((t) => toLocalParts(t, NEW_YORK).day);
    // 11 月 1 日只出现一次
    expect(days.filter((d) => d === 1)).toHaveLength(1);
  });

  it('跨 DST 的每日任务仍然每天一次', () => {
    const times = upcomingFireTimes(
      parseCron('0 9 * * *'),
      at('2026-03-06T00:00:00Z'),
      NEW_YORK,
      5,
    );
    const days = times.map((t) => toLocalParts(t, NEW_YORK).day);
    expect(days).toEqual([6, 7, 8, 9, 10]);
    // 本地时刻始终是 09:00，尽管 UTC 偏移变了
    expect(times.every((t) => toLocalParts(t, NEW_YORK).hour === 9)).toBe(true);
  });
});

describe('一次性触发与永不触发', () => {
  it('once@ 只触发一次，过了就不再触发', () => {
    const schedule = `once@${at('2026-06-10T09:00:00Z')}`;
    expect(nextFire(schedule, at('2026-06-09T00:00:00Z'), 'UTC')).toBe(at('2026-06-10T09:00:00Z'));
    expect(nextFire(schedule, at('2026-06-11T00:00:00Z'), 'UTC')).toBeUndefined();
  });

  it('parseSchedule 认得两种形式', () => {
    expect(parseSchedule('0 9 * * *').kind).toBe('cron');
    expect(parseSchedule('once@123').kind).toBe('once');
  });

  it('**永不触发的表达式返回 undefined 而不是死循环**（2 月 30 日）', () => {
    expect(
      nextFireTime(parseCron('0 0 30 2 *'), at('2026-01-01T00:00:00Z'), 'UTC'),
    ).toBeUndefined();
  });

  it('闰日每四年一次，不会被当成永不触发', () => {
    const fire = nextFireTime(parseCron('0 0 29 2 *'), at('2026-01-01T00:00:00Z'), 'UTC');
    expect(fire && localOf(fire, 'UTC')).toBe('2028-02-29 00:00');
  });
});
