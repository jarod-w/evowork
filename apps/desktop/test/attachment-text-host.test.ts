import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAttachmentTextHost } from '../src/main/attachment-text-host.js';
it('concurrent control/job saves remain atomic, removals survive late failure, and other task roots cannot read an attachment', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'evowork-attachment-text-')));
  const path = join(root, 'uploads', 'original.png');
  await mkdir(join(root, 'uploads'));
  await writeFile(path, 'invalid image fixture');
  const options = { home: root, runtimeRoot: join(root, 'missing-runtime') };
  const host = createAttachmentTextHost(options);
  const id = `attachment-${randomUUID()}`;
  try {
    await host.register(root, path, {
      id,
      name: 'source.png',
      sizeLabel: 'fixture',
      kind: 'image',
      state: 'ready',
      references: [],
    });
    await expect(host.control(root, { attachmentId: id, action: 'ocr' })).resolves.toHaveProperty(
      'id',
      id,
    );
    await host.control(root, { attachmentId: id, action: 'remove' });
    const other = join(root, 'other');
    await mkdir(other);
    await expect(host.status(other, id)).rejects.toThrow('当前任务目录');
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 10));
      const reloaded = createAttachmentTextHost(options);
      expect((await reloaded.status(root, id)).textProcessing?.state).toBe('removed');
    }
  } finally {
    host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
