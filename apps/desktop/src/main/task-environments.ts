/** 宿主权威环境登记。meta 与项目表同库；投影重建不会丢失归属和恢复关系。 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { classifyPath, workspaceRootRefusal } from '@evowork/policy';
import { readMeta, writeMeta, type Store } from '@evowork/store';
import type { ComposerReferenceView } from '../shared/ipc.js';

export interface TaskEnvironment {
  readonly cwd: string;
  readonly projectId: string | null;
  readonly managed: boolean;
  readonly draftId?: string;
  readonly threadId?: string;
  readonly sent?: boolean;
}

export interface TaskEnvironments {
  draftRoot(id: string): Promise<string>;
  prepare(id: string, projectId?: string): Promise<TaskEnvironment>;
  validate(cwd: string): Promise<string>;
  task(threadId: string): TaskEnvironment | undefined;
  bind(threadId: string, environment: TaskEnvironment): void;
  markSent(threadId: string): void;
  references(
    id: string,
    cwd: string,
    refs: readonly ComposerReferenceView[],
  ): Promise<readonly ComposerReferenceView[]>;
  remove(threadId: string): Promise<void>;
  discard(id: string): Promise<void>;
}

export function createTaskEnvironments(options: {
  readonly store: Store;
  readonly home: string;
  readonly dataDir: string;
  readonly projectRoot: (id: string) => string | undefined;
}): TaskEnvironments {
  const { store, home, dataDir } = options;
  const key = (kind: string, id: string) => `evowork.environment.${kind}.${id}`;
  const load = (kind: string, id: string): TaskEnvironment | undefined => {
    const raw = readMeta(store.db, key(kind, id));
    return raw ? (JSON.parse(raw) as TaskEnvironment) : undefined;
  };
  const save = (kind: string, id: string, value: TaskEnvironment) =>
    writeMeta(store.db, key(kind, id), JSON.stringify(value));
  const validId = (id: string) => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('无效的草稿标识。');
    return id;
  };
  const managedRoot = async (kind: string, id: string): Promise<string> => {
    const parent = join(dataDir, kind);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const realData = await realpath(dataDir);
    if ((await realpath(parent)) !== join(realData, kind))
      throw new Error('任务目录被替换，请检查本地数据目录。');
    const path = join(parent, validId(id));
    await mkdir(path, { recursive: true, mode: 0o700 });
    const real = await realpath(path);
    if (real !== join(realData, kind, id)) throw new Error('任务目录被替换，请检查本地数据目录。');
    return real;
  };
  const validate = async (cwd: string): Promise<string> => {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('任务目录不存在。');
    const real = await realpath(cwd);
    if (real !== cwd) throw new Error('任务目录已被替换，请检查后再继续。');
    const realHome = await realpath(home);
    const refusal = workspaceRootRefusal(real, realHome);
    if (refusal?.kind === 'too-broad') throw new Error(refusal.reason);
    if (refusal?.kind === 'evowork-data') {
      const realData = await realpath(dataDir);
      const registered = store.db
        .prepare("SELECT value FROM meta WHERE key LIKE 'evowork.environment.%'")
        .all() as { value: string }[];
      const permitted = registered.some(({ value }) => {
        if (!value) return false;
        const env = JSON.parse(value) as TaskEnvironment;
        return (
          env.managed && env.cwd === real && real.startsWith(`${join(realData, 'workspaces')}/`)
        );
      });
      // 助理为宿主固定环境，不能通过前端传任意内部路径冒充。
      if (!permitted && real !== join(realData, 'assistant')) throw new Error(refusal.reason);
    }
    const verdict = classifyPath(real, { home: realHome, workspaceRoot: real });
    if (verdict.verdict === 'hard-block') throw new Error(verdict.reason);
    return real;
  };
  const task = (threadId: string) => load('task', threadId);
  return {
    draftRoot: (id) => managedRoot('drafts', id),
    validate,
    task,
    async prepare(id, projectId) {
      validId(id);
      const previous = load('draft', id);
      if (previous?.threadId) {
        if ((projectId ?? null) !== previous.projectId)
          throw new Error('任务已经创建，重试需保留原项目；换项目请新建任务。');
        await validate(previous.cwd);
        return previous;
      }
      const cwd = projectId
        ? options.projectRoot(projectId)
        : previous?.managed
          ? previous.cwd
          : await managedRoot('workspaces', randomUUID());
      if (!cwd) throw new Error('项目没有可用目录，请重新选择项目。');
      const env: TaskEnvironment = {
        cwd: await realpath(cwd),
        projectId: projectId ?? null,
        managed: !projectId,
        draftId: id,
      };
      save('draft', id, env);
      await validate(env.cwd);
      return env;
    },
    bind(threadId, environment) {
      const env = { ...environment, threadId };
      save('task', threadId, env);
      if (environment.draftId) save('draft', environment.draftId, env);
    },
    markSent(threadId) {
      const env = task(threadId);
      if (!env) return;
      const sent = { ...env, sent: true };
      save('task', threadId, sent);
      if (env.draftId) save('draft', env.draftId, sent);
    },
    async references(id, cwd, refs) {
      const from = await managedRoot('drafts', id);
      const base = join(from, 'uploads');
      if (
        !refs.some((ref) =>
          ref.type === 'text' ? ref.text.includes(base) : ref.path.startsWith(`${base}/`),
        )
      )
        return refs;
      await validate(cwd);
      const uploads = join(cwd, 'uploads');
      await mkdir(uploads, { recursive: true });
      if ((await realpath(uploads)) !== uploads) throw new Error('附件目录被替换，无法发送。');
      const target = join(uploads, `draft-${validId(id)}`);
      await mkdir(target, { recursive: true });
      if ((await realpath(target)) !== target) throw new Error('附件目录被替换，无法发送。');
      const checkSource = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('附件暂存含符号链接，无法发送。');
          if (entry.isDirectory()) await checkSource(join(dir, entry.name));
        }
      };
      await checkSource(base);
      await checkSource(target);
      // 覆盖仅限本草稿暂存副本，重试使用同一目标。不能覆盖用户工作文件。
      await cp(base, target, { recursive: true, dereference: false });
      const rewrite = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isSymbolicLink()) throw new Error('附件暂存含符号链接，无法发送。');
          if (entry.isDirectory()) await rewrite(path);
          else if (/\.(md|json|txt|csv)$/i.test(entry.name)) {
            const text = await readFile(path, 'utf8');
            if (text.includes(base)) await writeFile(path, text.replaceAll(base, target), 'utf8');
          }
        }
      };
      await rewrite(target);
      return refs.map((ref) =>
        ref.type === 'text'
          ? { ...ref, text: ref.text.replaceAll(base, target) }
          : {
              ...ref,
              path: ref.path.startsWith(`${base}/`)
                ? target + ref.path.slice(base.length)
                : ref.path,
            },
      );
    },
    async remove(threadId) {
      const env = task(threadId);
      if (!env) return;
      const users = store.db
        .prepare("SELECT value FROM meta WHERE key LIKE 'evowork.environment.task.%'")
        .all() as { value: string }[];
      const shared = users.some(
        ({ value }) =>
          value &&
          (JSON.parse(value) as TaskEnvironment).cwd === env.cwd &&
          (JSON.parse(value) as TaskEnvironment).threadId !== threadId,
      );
      if (env.managed && !shared) {
        await validate(env.cwd);
        await rm(env.cwd, { recursive: true, force: true });
      }
      writeMeta(store.db, key('task', threadId), '');
      if (env.draftId) {
        await this.discard(env.draftId);
        writeMeta(store.db, key('draft', env.draftId), '');
      }
    },
    async discard(id) {
      const path = await managedRoot('drafts', id);
      await rm(path, { recursive: true, force: true });
      const env = load('draft', id);
      if (env?.managed && !env.threadId) {
        await validate(env.cwd);
        await rm(env.cwd, { recursive: true, force: true });
      }
      if (!env?.threadId) writeMeta(store.db, key('draft', id), '');
    },
  };
}
