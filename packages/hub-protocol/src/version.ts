/**
 * 版本比较与吊销范围（13 §4.1 的 `version` / `minAppVersion` / `revoked[].versions`）。
 *
 * 只认 `MAJOR.MINOR.PATCH[-pre]`。认不出来的版本**不当成最小也不当成最大**：
 * `parseVersion` 返回 undefined，由调用方按最保守的方向处理（吊销判命中、更新判不可用）。
 */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly string[];
}

const VERSION_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION_RE.exec(text.trim());
  if (m === null) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] !== undefined ? m[4].split('.') : [],
  };
}

export function isVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

/** a < b → 负数；相等 → 0；a > b → 正数。认不出来的版本抛错 —— 调用方先用 `isVersion` 判。 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === undefined || vb === undefined) throw new Error(`不是版本号：${va ? b : a}`);
  return compareParsed(va, vb);
}

function compareParsed(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // 有预发布标记的比正式版小
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const COMPARATOR_RE = /^(<=|>=|<|>|=)?\s*(.+)$/;

/**
 * 范围是空格分隔的比较式，全部成立才算命中：`<1.2.1`、`>=1.0.0 <1.2.0`、`1.1.0`、`*`。
 *
 * **认不出来的范围判命中**：它只用在吊销上，宁可多停用一个，也不能因为写错一个字符就放过。
 */
export function matchesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  const parts = range
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  if (parts.length === 0) return true;
  if (v === undefined) return true;
  for (const part of parts) {
    if (part === '*') continue;
    const m = COMPARATOR_RE.exec(part);
    const target = m?.[2] !== undefined ? parseVersion(m[2]) : undefined;
    if (m === null || target === undefined) return true;
    const d = compareParsed(v, target);
    const op = m[1] ?? '=';
    const ok =
      op === '<'
        ? d < 0
        : op === '<='
          ? d <= 0
          : op === '>'
            ? d > 0
            : op === '>='
              ? d >= 0
              : d === 0;
    if (!ok) return false;
  }
  return true;
}

export function isValidRange(range: string): boolean {
  const parts = range
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (part === '*') return true;
    const m = COMPARATOR_RE.exec(part);
    return m?.[2] !== undefined && parseVersion(m[2]) !== undefined;
  });
}
