/** A local command; intercept before model and attachment preparation. */
export function isImportCommand(text: string): boolean {
  return /^\/import(?:\s|$)/u.test(text.trim());
}
