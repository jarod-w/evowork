import { isAbsolute, relative, sep } from 'node:path';

/** Strict descendant comparison for native paths; callers resolve symlinks separately. */
export function isDescendantPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
