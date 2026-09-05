/**
 * 自然语言触发解析（07 §3.3 的第 ② 档，清单 §7「自然语言配置」的落点）。
 *
 * ## 它**不调模型**
 *
 * 07 §3.3 的原话：解析在本机完成（规则 + 词表，不调模型），失败则回落到第 ① 档并提示。
 * 理由：把"设定一个每天跑的任务"这件事的可靠性押在一次模型调用上不合适。
 *
 * 这条同时意味着**认不出来是正常结果**，不是错误。所以返回类型是
 * `ParsedSchedule | undefined`，而 UI 在 undefined 时回落到常用档 —— 不报错。
 *
 * ## 回显确认是必须的
 *
 * 解析出 cron 之后要**用人话回显**让用户确认（`describeCron`）。
 * "每个工作日下午六点"解析成 `0 18 * * 1-5` 之后，用户看到的应该是
 * "每周一至周五 18:00"，而不是那串 cron。
 */

export interface ParsedSchedule {
  readonly cron: string;
  /** 回显给用户确认的人话 */
  readonly description: string;
}

const DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 把「下午六点」「18:00」「早上九点半」都变成 {hour, minute}。 */
export function parseTimeOfDay(text: string): { hour: number; minute: number } | undefined {
  const hhmm = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (hour <= 23 && minute <= 59) return applyMeridiem(text, hour, minute);
  }

  const cn =
    /([零〇一二两三四五六七八九十]+|\d{1,2})\s*点(半|[零〇一二两三四五六七八九十\d]*分?)?/.exec(
      text,
    );
  if (cn) {
    const hour = toNumber(cn[1] ?? '');
    if (hour === undefined || hour > 23) return undefined;
    const rest = cn[2] ?? '';
    const minute = rest === '半' ? 30 : (toNumber(rest.replace('分', '')) ?? 0);
    if (minute > 59) return undefined;
    return applyMeridiem(text, hour, minute);
  }
  return undefined;
}

function applyMeridiem(
  text: string,
  hour: number,
  minute: number,
): { hour: number; minute: number } {
  // 「下午六点」= 18 点。已经写成 18 的不再加 —— 「下午 18 点」不该变成 30 点
  const afternoon = /下午|晚上|傍晚|夜里|晚间/.test(text);
  const morning = /上午|早上|早晨|凌晨/.test(text);
  if (afternoon && hour < 12) return { hour: hour + 12, minute };
  if (morning && hour === 12) return { hour: 0, minute };
  return { hour, minute };
}

function toNumber(token: string): number | undefined {
  if (token === '') return undefined;
  if (/^\d+$/.test(token)) return Number(token);
  if (DIGITS[token] !== undefined) return DIGITS[token];
  // 「十五」「二十三」这类
  if (token.startsWith('十')) return 10 + (DIGITS[token.slice(1)] ?? 0);
  const match = /^([一二两三四五六七八九])十([零〇一二三四五六七八九])?$/.exec(token);
  if (match) return (DIGITS[match[1] as string] ?? 0) * 10 + (DIGITS[match[2] ?? ''] ?? 0);
  return undefined;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function parseNaturalSchedule(input: string): ParsedSchedule | undefined {
  const text = input.trim();
  if (text === '') return undefined;
  const time = parseTimeOfDay(text) ?? { hour: 9, minute: 0 };
  const clock = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;

  // 工作日
  if (/工作日|每个工作日|周一到周五|周一至周五/.test(text)) {
    return { cron: `${time.minute} ${time.hour} * * 1-5`, description: `每周一至周五 ${clock}` };
  }

  // 每周 X（支持「每周一、周三」这种多选）
  const weekdayMatches = [...text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])/g)];
  if (weekdayMatches.length > 0) {
    const days = [...new Set(weekdayMatches.map((m) => WEEKDAYS[m[1] as string] ?? 0))].sort();
    return {
      cron: `${time.minute} ${time.hour} * * ${days.join(',')}`,
      description: `每${days.map((d) => WEEKDAY_LABELS[d]?.slice(1)).join('、')} ${clock}`,
    };
  }

  // 每月 N 号
  const monthly = /每月\s*([零〇一二两三四五六七八九十\d]+)\s*[号日]/.exec(text);
  if (monthly) {
    const day = toNumber(monthly[1] ?? '');
    if (day !== undefined && day >= 1 && day <= 31) {
      return {
        cron: `${time.minute} ${time.hour} ${day} * *`,
        description: `每月 ${day} 号 ${clock}`,
      };
    }
  }

  // 每 N 小时 / 每 N 分钟
  const everyHours = /每\s*([零〇一二两三四五六七八九十\d]+)\s*(?:个)?小时/.exec(text);
  if (everyHours) {
    const step = toNumber(everyHours[1] ?? '');
    if (step !== undefined && step >= 1 && step <= 23) {
      return { cron: `0 */${step} * * *`, description: `每 ${step} 小时（整点）` };
    }
  }
  const everyMinutes = /每\s*([零〇一二两三四五六七八九十\d]+)\s*(?:分钟|分)/.exec(text);
  if (everyMinutes) {
    const step = toNumber(everyMinutes[1] ?? '');
    if (step !== undefined && step >= 1 && step <= 59) {
      return { cron: `*/${step} * * * *`, description: `每 ${step} 分钟` };
    }
  }

  if (/每天|每日|天天/.test(text)) {
    return { cron: `${time.minute} ${time.hour} * * *`, description: `每天 ${clock}` };
  }

  // 只说了时间没说频率 → 认成每天，但**回显里说清这个假设**
  if (parseTimeOfDay(text)) {
    return {
      cron: `${time.minute} ${time.hour} * * *`,
      description: `每天 ${clock}（没说频率，按每天算）`,
    };
  }

  return undefined;
}

/** cron → 人话（第 ③ 档也要回显，07 §3.3 说预览是三档共有的）。 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dom, , dow] = parts as [string, string, string, string, string];

  const clock =
    /^\d+$/.test(minute) && /^\d+$/.test(hour)
      ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
      : undefined;

  if (dow === '1-5') return `每周一至周五 ${clock ?? cron}`;
  if (dow !== '*' && dow !== '?') {
    const days = dow.split(',').map((d) => WEEKDAY_LABELS[Number(d)] ?? d);
    return `每${days.join('、')} ${clock ?? ''}`.trim();
  }
  if (dom !== '*' && dom !== '?') return `每月 ${dom} 号 ${clock ?? ''}`.trim();
  if (hour.startsWith('*/')) return `每 ${hour.slice(2)} 小时`;
  if (minute.startsWith('*/')) return `每 ${minute.slice(2)} 分钟`;
  return clock ? `每天 ${clock}` : cron;
}
