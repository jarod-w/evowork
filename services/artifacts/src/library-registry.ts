/** Managed single-file imports and durable local scope decisions. No directory subscription. */
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

export interface LibrarySourceRecord {
  id: string;
  name: string;
  path: string;
  source: 'mine' | 'artifact' | 'attachment';
  artifactId?: string;
  projectId?: string;
  threadId?: string;
  hash?: string;
  stopped: boolean;
  excluded: boolean;
  ocrAllowed: boolean;
  createdAt: number;
  nextPage?: number;
  rotation?: 0 | 90 | 180 | 270;
}
interface RegistryManifest {
  version: 1;
  enabled: boolean;
  records: LibrarySourceRecord[];
}
export const LIBRARY_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

export async function openLibraryRegistry(root: string) {
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== resolve(root))
    throw new Error('LIBRARY_ROOT_UNSAFE');
  const manifestPath = join(root, 'sources.json');
  let manifest: RegistryManifest = { version: 1, enabled: false, records: [] };
  try {
    if ((await lstat(manifestPath)).size > 4 * 1024 * 1024)
      throw new Error('LIBRARY_MANIFEST_LIMIT');
    const value = JSON.parse(await readFile(manifestPath, 'utf8')) as RegistryManifest;
    if (
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      value.records.length > 10_000 ||
      typeof value.enabled !== 'boolean'
    )
      throw new Error('LIBRARY_MANIFEST_INVALID');
    const ids = new Set<string>();
    for (const record of value.records) {
      if (
        typeof record.id !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(record.id) ||
        ids.has(record.id) ||
        typeof record.path !== 'string' ||
        typeof record.name !== 'string' ||
        !['mine', 'artifact', 'attachment'].includes(record.source) ||
        typeof record.stopped !== 'boolean' ||
        typeof record.excluded !== 'boolean' ||
        typeof record.ocrAllowed !== 'boolean' ||
        (record.rotation !== undefined && ![0, 90, 180, 270].includes(record.rotation))
      )
        throw new Error('LIBRARY_MANIFEST_INVALID');
      if (
        record.source !== 'artifact' &&
        record.path !== join(root, record.id, `original${extname(record.path)}`)
      )
        throw new Error('LIBRARY_MANIFEST_INVALID');
      ids.add(record.id);
    }
    manifest = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let saving = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = JSON.stringify(manifest);
    const operation = saving.then(async () => {
      const temp = `${manifestPath}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, manifestPath);
    });
    saving = operation.catch(() => {});
    return operation;
  };
  return {
    enabled: () => manifest.enabled,
    records: () => manifest.records.map((r) => ({ ...r })),
    async enable(): Promise<void> {
      manifest.enabled = true;
      await save();
    },
    async update(record: LibrarySourceRecord): Promise<void> {
      const index = manifest.records.findIndex((r) => r.id === record.id);
      if (index < 0) {
        if (manifest.records.length >= 10_000) throw new Error('LIBRARY_DOCUMENT_LIMIT');
        manifest.records.push({ ...record });
      } else manifest.records[index] = { ...record };
      await save();
    },
    async importFile(path: string): Promise<LibrarySourceRecord> {
      const info = await lstat(path),
        ext = extname(path).toLowerCase();
      const limit = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? 20 : 200;
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !LIBRARY_EXTENSIONS.has(ext) ||
        info.size > limit * 1024 * 1024
      )
        throw new Error('LIBRARY_IMPORT_REFUSED');
      const id = randomUUID(),
        directory = join(root, id),
        destination = join(directory, `original${ext}`);
      await mkdir(directory);
      try {
        await copyFile(path, destination);
        const copied = await lstat(destination);
        if (copied.size !== info.size || copied.size > limit * 1024 * 1024)
          throw new Error('LIBRARY_IMPORT_CHANGED');
        const digest = createHash('sha256');
        for await (const bytes of createReadStream(destination)) digest.update(bytes as Buffer);
        const record: LibrarySourceRecord = {
          hash: digest.digest('hex'),
          id,
          name: basename(path),
          path: destination,
          source: 'mine',
          stopped: false,
          excluded: false,
          ocrAllowed: false,
          createdAt: Date.now(),
        };
        await this.update(record);
        return record;
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    /** Explicitly replace only the managed copy; external originals remain untouched. */
    async replaceImport(id: string, path: string): Promise<LibrarySourceRecord> {
      const record = manifest.records.find((r) => r.id === id && !r.excluded);
      if (!record || record.source === 'artifact') throw new Error('LIBRARY_IMPORT_UNKNOWN');
      const ext = extname(path).toLowerCase();
      const info = await lstat(path);
      const limit = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? 20 : 200;
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        ext !== extname(record.path) ||
        info.size > limit * 1024 * 1024
      )
        throw new Error('请选择同类型且未超过大小上限的文件。');
      const directory = join(root, id);
      if ((await realpath(directory)) !== resolve(directory))
        throw new Error('LIBRARY_ROOT_UNSAFE');
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await copyFile(path, temporary);
        if ((await lstat(temporary)).size !== info.size) throw new Error('LIBRARY_IMPORT_CHANGED');
        const digest = createHash('sha256');
        for await (const bytes of createReadStream(temporary)) digest.update(bytes as Buffer);
        await rename(temporary, record.path);
        const { rotation: _rotation, ...base } = record;
        const next = {
          ...base,
          name: basename(path),
          hash: digest.digest('hex'),
          stopped: false,
          ocrAllowed: false,
          nextPage: 1,
        };
        await this.update(next);
        return next;
      } finally {
        await rm(temporary, { force: true });
      }
    },
    /** Managed imports delete only their controlled copy. The external original is never touched. */
    async deleteImport(id: string): Promise<void> {
      const record = manifest.records.find((r) => r.id === id);
      if (!record || record.source === 'artifact') throw new Error('LIBRARY_IMPORT_UNKNOWN');
      record.excluded = true;
      await save();
      const directory = join(root, record.id);
      if ((await realpath(directory)) !== resolve(directory))
        throw new Error('LIBRARY_ROOT_UNSAFE');
      await rm(directory, { recursive: true, force: true });
      manifest.records = manifest.records.filter((r) => r.id !== id);
      await save();
    },
  };
}
export type LibraryRegistry = Awaited<ReturnType<typeof openLibraryRegistry>>;
