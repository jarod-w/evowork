import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 只供真实 app-server E2E 植入已整理的记忆。
 *
 * 这个 helper 故意留在适配层的 test-support：生产代码不得绕过协议读写内核文件。
 */
export function seedMemorySummary(kernelHome, marker) {
  const directory = join(kernelHome, 'memories');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'memory_summary.md'), `v1\n${marker}\n`);
}
