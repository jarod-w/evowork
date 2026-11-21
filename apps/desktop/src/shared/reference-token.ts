import { skillToken } from './skill-token.js';

const BOUNDARY = /[\s.,!?;:，。！？；：、）)\]}]/u;

/** 可见 token 的每一次出现。后面必须是结尾或分隔符，避免 `@a` 命中 `@ab`。 */
export function tokenOccurrences(
  value: string,
  token: string,
): readonly { readonly start: number; readonly end: number }[] {
  if (token === '') return [];
  const found: { start: number; end: number }[] = [];
  let offset = value.indexOf(token);
  while (offset >= 0) {
    const next = value[offset + token.length];
    if (next === undefined || BOUNDARY.test(next))
      found.push({ start: offset, end: offset + token.length });
    offset = value.indexOf(token, offset + token.length);
  }
  return found;
}

export function referenceTokenStrings(
  references: readonly {
    readonly type: string;
    readonly name?: string;
    readonly path?: string;
  }[],
  candidates: readonly { readonly path?: string | undefined; readonly label: string }[],
): readonly string[] {
  const tokens = new Set<string>();
  for (const reference of references) {
    if ((reference.type !== 'mention' && reference.type !== 'skill') || !reference.path) continue;
    const candidate = candidates.find((item) => item.path === reference.path);
    const labels = new Set(
      [reference.name, candidate?.label].filter((label): label is string => Boolean(label)),
    );
    for (const label of labels) {
      if (reference.type === 'skill') {
        tokens.add(skillToken(label));
        tokens.add(`$${label}`);
      } else tokens.add(`@${label}`);
    }
  }
  return [...tokens];
}

/** 长 token 优先，重叠的短 token 让位。结果按出现位置排序。 */
export function tokenSpans(
  value: string,
  tokens: readonly string[],
): readonly { readonly start: number; readonly end: number }[] {
  const ordered = [...new Set(tokens.filter((token) => token !== ''))].sort(
    (left, right) => right.length - left.length,
  );
  const taken: { start: number; end: number }[] = [];
  const overlaps = (start: number, end: number) =>
    taken.some((span) => start < span.end && end > span.start);
  for (const token of ordered) {
    for (const hit of tokenOccurrences(value, token)) {
      if (!overlaps(hit.start, hit.end)) taken.push(hit);
    }
  }
  return taken.sort((left, right) => left.start - right.start);
}
