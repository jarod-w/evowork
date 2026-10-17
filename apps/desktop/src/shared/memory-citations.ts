/** Untrusted model citation metadata is display-only: never turn paths into file actions. */
export function memoryCitationEntries(value: unknown): readonly {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly note: string;
}[] {
  if (!value || typeof value !== 'object' || !('entries' in value) || !Array.isArray(value.entries))
    return [];
  return value.entries.filter(
    (
      entry,
    ): entry is {
      path: string;
      lineStart: number;
      lineEnd: number;
      note: string;
    } =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        typeof entry.note === 'string' &&
        Number.isSafeInteger(entry.lineStart) &&
        Number.isSafeInteger(entry.lineEnd) &&
        entry.lineStart > 0 &&
        entry.lineEnd >= entry.lineStart,
      ),
  );
}
