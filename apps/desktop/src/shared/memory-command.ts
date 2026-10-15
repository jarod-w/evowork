/** Recognize the local command before any model, attachment, or task preparation. */
export function isMemoriesCommand(text: string): boolean {
  return /^\/memories(?:\s|$)/u.test(text.trim());
}
