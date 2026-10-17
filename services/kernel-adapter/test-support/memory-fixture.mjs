import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 只供真实 app-server E2E 植入已整理的记忆。
 *
 * 这个 helper 故意留在适配层的 test-support：生产代码不得绕过协议读写内核文件。
 */
export function seedMemorySummary(kernelHome, marker) {
  const directory = join(kernelHome, 'memories');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'memory_summary.md'), `v1\n${marker}\n`);
  writeFileSync(join(directory, 'MEMORY.md'), `# Synthetic memory\n${marker}\n`);
}

export function memoryConsolidationIdle(kernelHome) {
  const db = new DatabaseSync(join(kernelHome, 'memories_1.sqlite'), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT status FROM jobs WHERE kind = 'memory_consolidate_global' AND job_key = 'global'",
      )
      .get();
    return row?.status === 'done' || row?.status === 'pending';
  } finally {
    db.close();
  }
}

/** Read-only job outcome for a disposable real-model fixture; never a product API. */
export function memoryRuntimeDiagnostics(kernelHome) {
  const db = new DatabaseSync(join(kernelHome, 'memories_1.sqlite'), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT kind, status, last_error, retry_remaining FROM jobs WHERE kind = 'memory_consolidate_global'",
      )
      .all();
  } finally {
    db.close();
  }
}

/** Advance only the isolated fixture past the native six-hour success cooldown. */
export function ageMemoryConsolidation(kernelHome) {
  const db = new DatabaseSync(join(kernelHome, 'memories_1.sqlite'));
  try {
    db.prepare(
      "UPDATE jobs SET finished_at = ? WHERE kind = 'memory_consolidate_global' AND status != 'running'",
    ).run(Math.floor(Date.now() / 1000) - 7 * 60 * 60);
  } finally {
    db.close();
  }
}

/** Only tests age a real completed thread to exercise the native idle-time gate. */
export function ageMemoryInput(kernelHome, threadId) {
  const name = readdirSync(kernelHome).find((file) => /^state_\d+\.sqlite$/.test(file));
  if (!name) throw new Error('测试内核没有建立状态数据库');
  const db = new DatabaseSync(join(kernelHome, name));
  try {
    const stamp = Date.now() - 8 * 60 * 60 * 1000;
    const result = db
      .prepare('UPDATE threads SET created_at = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?')
      .run(Math.floor(stamp / 1000) - 60, Math.floor(stamp / 1000), stamp, threadId);
    if (result.changes !== 1) throw new Error('测试任务没有进入内核状态库');
  } finally {
    db.close();
  }
}
