import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { ERROR_CODE, JsonRpcCallError, METHOD, type JsonRpcPeer } from '@evowork/protocol';

export interface MemoryImportProject {
  readonly key: string;
  readonly path?: string;
}

export interface MemoryImportHistory {
  readonly id: string;
  readonly completedAt: number;
  readonly projects: readonly {
    readonly key: string;
    readonly ok: boolean;
    readonly reason?: string;
  }[];
}

export interface MemoryImportSync {
  readonly enabled: boolean;
  readonly projectKeys: readonly string[];
  readonly lastCheckedAt?: number;
  readonly lastCompletedAt?: number;
  readonly error?: string;
  readonly pending?: { readonly id: string; readonly startedAt: number };
}

export interface MemoryImportStatus {
  readonly supported: boolean;
  readonly reason?: string;
  readonly history: readonly MemoryImportHistory[];
  readonly sync?: MemoryImportSync;
}

export interface MemoryImportDetection {
  readonly selectionId: string;
  readonly projects: readonly MemoryImportProject[];
}

interface MigrationItem {
  readonly itemType: string;
  readonly description: string;
  readonly cwd: string | null;
  readonly details?: {
    readonly memory?: readonly string[];
    readonly sessions?: readonly { readonly path: string; readonly cwd: string }[];
  } | null;
}

interface ImportRecord {
  readonly importId: string;
  readonly completedAtMs: number;
  readonly providerId?: string | null;
  readonly successes: readonly { readonly itemType: string; readonly source?: string | null }[];
  readonly failures: readonly {
    readonly itemType: string;
    readonly source?: string | null;
    readonly message: string;
  }[];
}

/** A refusal before the migration write was sent; safe for the UI to offer a fresh selection. */
export class MemoryImportRefusal extends Error {}

function failureReason(error: string): string {
  if (/permission denied|access.*denied/i.test(error)) return '无法读取来源文件，请检查目录权限。';
  if (/not found|no such file/i.test(error)) return '来源文件已不存在，请重新检测。';
  if (/cwd|scope/i.test(error)) return '无法确认项目目录，请检查来源项目是否仍然存在。';
  return '这个项目未能导入，请检查来源文件后重新检测。';
}

/** Native migration only: no filesystem access, generated-memory reads, or arbitrary item writes. */
export function createMemoryImporter(
  peer: () => JsonRpcPeer,
  persistence?: {
    read(): MemoryImportSync | undefined;
    write(value: MemoryImportSync): void;
  },
) {
  let selection: { id: string; keys: Set<string> } | undefined;
  let importing = false;
  let checking = false;
  let submitting = false;
  let running = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sync: MemoryImportSync = persistence?.read() ?? { enabled: false, projectKeys: [] };
  const save = (value: MemoryImportSync) => {
    persistence?.write(value);
    sync = value;
  };
  const pause = (error: string) => {
    sync = { ...sync, enabled: false, error };
    try {
      persistence?.write(sync);
    } catch {
      // Never submit a write when its preflight pause could not be persisted.
      sync = { ...sync, error: '同步状态未能保存，本次运行已暂停。请检查本机存储后重试。' };
    }
  };

  async function request<T>(method: string, params?: unknown): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        peer().request<T>(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('导入操作暂未返回，请核对历史后再操作。')),
            20_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function records(): Promise<readonly ImportRecord[]> {
    const response = await request<{ readonly data: readonly ImportRecord[] }>(
      METHOD.externalAgentImportHistoriesRead,
    );
    return response.data;
  }

  async function history(): Promise<readonly MemoryImportHistory[]> {
    return (await records())
      .map((record): MemoryImportHistory => ({
        id: record.importId,
        completedAt: record.completedAtMs,
        projects: [
          ...record.successes
            .filter((item) => item.itemType === 'MEMORY')
            .map((item) => ({ key: item.source ?? '未知项目', ok: true })),
          ...record.failures
            .filter((item) => item.itemType === 'MEMORY')
            .map((item) => ({
              key: item.source ?? '未知项目',
              ok: false,
              reason: failureReason(item.message),
            })),
        ],
      }))
      .filter((record) => record.projects.length > 0);
  }

  async function status(): Promise<MemoryImportStatus> {
    try {
      const [config, records] = await Promise.all([
        request<{ readonly config: { readonly features?: Record<string, unknown> } }>(
          METHOD.configRead,
          { includeLayers: false },
        ),
        history(),
      ]);
      const completed = sync.pending
        ? records.find((record) => record.id === sync.pending?.id)
        : undefined;
      if (completed) finishSync(completed);
      return config.config.features?.external_agent_memory_import === true
        ? { supported: true, history: records, sync }
        : { supported: false, reason: '当前配置未开启外部记忆导入。', history: records, sync };
    } catch (error) {
      if (error instanceof JsonRpcCallError && error.code === ERROR_CODE.methodNotFound)
        return {
          supported: false,
          reason: '当前版本不支持项目记忆导入，请更新应用。',
          history: [],
          sync,
        };
      throw new Error('无法读取导入状态，请稍后重试。');
    }
  }

  async function detect(): Promise<MemoryImportDetection> {
    if (importing || checking) throw new Error('正在导入，请等待结果后重新检测。');
    selection = undefined;
    const state = await status();
    if (!state.supported) throw new Error(state.reason);
    const response = await request<{ readonly items: readonly MigrationItem[] }>(
      METHOD.externalAgentDetect,
      { includeHome: true },
    ).catch(() => {
      throw new Error('无法检测项目记忆，请检查来源或更新应用后重试。');
    });
    const paths = new Map<string, string>();
    for (const item of response.items)
      for (const session of item.details?.sessions ?? [])
        paths.set(basename(dirname(session.path)), session.cwd);
    const keys = new Set(
      response.items
        .filter((item) => item.itemType === 'MEMORY')
        .flatMap((item) => item.details?.memory ?? []),
    );
    selection = { id: randomUUID(), keys };
    return {
      selectionId: selection.id,
      projects: [...keys].map((key) => ({
        key,
        ...(paths.has(key) ? { path: paths.get(key)! } : {}),
      })),
    };
  }

  function finishSync(record: MemoryImportHistory) {
    const { pending: _pending, ...rest } = sync;
    save({ ...rest, lastCompletedAt: record.completedAt });
    if (record.projects.some((project) => !project.ok))
      pause('部分项目同步失败，已暂停。请核对导入历史后重新开启。');
  }

  async function checkSync(): Promise<void> {
    if (!sync.enabled || checking || importing) return;
    checking = true;
    const generation = revision;
    try {
      if (sync.pending) {
        const pending = sync.pending;
        const record = (await history()).find((record) => record.id === pending.id);
        if (!sync.enabled || generation !== revision || sync.pending?.id !== pending.id) return;
        if (record) {
          finishSync(record);
        } else if (Date.now() - sync.pending.startedAt > 60_000)
          pause('同步结果未确认，已暂停。请核对导入历史后重新开启。');
        return;
      }
      const state = await status();
      if (!sync.enabled || generation !== revision) return;
      if (!state.supported) {
        pause(state.reason ?? '当前版本不支持同步。');
        return;
      }
      const found = await request<{ readonly items: readonly MigrationItem[] }>(
        METHOD.externalAgentDetect,
        { includeHome: true },
      );
      if (!sync.enabled || generation !== revision) return;
      const keys = [
        ...new Set(
          found.items
            .filter((item) => item.itemType === 'MEMORY')
            .flatMap((item) => item.details?.memory ?? []),
        ),
      ].filter((key) => sync.projectKeys.includes(key));
      save({ ...sync, lastCheckedAt: Date.now() });
      if (!keys.length) return;
      submitting = true;
      // Persist a pause before submitting: a crash or unknown response must never replay a write.
      const authorized = sync;
      persistence?.write({
        ...sync,
        enabled: false,
        error: '同步结果未确认，已暂停。请核对导入历史后重新开启。',
      });
      const result = await request<{ readonly importId: string }>(METHOD.externalAgentImport, {
        migrationItems: [
          { itemType: 'MEMORY', description: '同步项目记忆', cwd: null, details: { memory: keys } },
        ],
        source: 'evowork',
        providerId: 'claude-code',
      });
      // A concurrent off action revokes future checks; do not restore it after the request returns.
      if (!running || generation !== revision) return;
      save({ ...authorized, pending: { id: result.importId, startedAt: Date.now() } });
    } catch {
      if (generation !== revision) return;
      pause('同步未完成，已暂停。请核对导入历史与来源后重新开启。');
    } finally {
      submitting = false;
      checking = false;
    }
  }

  function schedule() {
    if (!running || !sync.enabled) return;
    clearTimeout(timer);
    const pendingId = sync.pending?.id;
    timer = setTimeout(
      () => {
        // A foreground status read may already have settled this batch. Do not turn a
        // one-second result check into an early source scan.
        if (pendingId && sync.pending?.id !== pendingId) {
          schedule();
          return;
        }
        void checkSync().finally(schedule);
      },
      pendingId ? 1000 : 60_000,
    );
    timer.unref?.();
  }

  return {
    start() {
      running = true;
      void checkSync().finally(schedule);
    },
    stop() {
      if (sync.enabled && submitting) pause('同步结果未确认，已暂停。请核对导入历史后重新开启。');
      revision++;
      running = false;
      clearTimeout(timer);
    },
    async setSync(enabled: boolean) {
      if (typeof enabled !== 'boolean') throw new Error('同步设置无效。');
      if (checking && enabled) throw new Error('正在检查同步，请稍后重试。');
      const generation = ++revision;
      if (!enabled) {
        running = false;
        clearTimeout(timer);
        save({ ...sync, enabled: false });
      } else {
        const state = await status();
        if (!state.supported) throw new Error(state.reason);
        if (sync.pending && !(await history()).some((record) => record.id === sync.pending?.id))
          throw new Error('同步结果尚未确认，请核对导入历史后再试。');
        const keys = [
          ...new Set(
            (await records())
              .filter((record) => record.providerId === 'claude-code')
              .flatMap((record) =>
                record.successes
                  .filter((item) => item.itemType === 'MEMORY')
                  .flatMap((item) => (item.source ? [item.source] : [])),
              ),
          ),
        ];
        if (generation !== revision) return sync;
        if (!keys.length) throw new Error('请先导入 Claude Code 项目记忆。');
        if (checking || importing) throw new Error('正在导入或同步，请稍后重试。');
        save({ enabled: true, projectKeys: keys });
        running = true;
        clearTimeout(timer);
        void checkSync().finally(schedule);
      }
      return sync;
    },
    async reset<T>(perform: () => Promise<T>): Promise<T> {
      if (checking || importing) throw new Error('正在导入或同步，请等待结果后再清空记忆。');
      importing = true;
      try {
        if (sync.pending && !(await history()).some((record) => record.id === sync.pending?.id))
          throw new Error('同步结果尚未确认，请核对导入历史后再清空记忆。');
        revision++;
        running = false;
        clearTimeout(timer);
        save({ enabled: false, projectKeys: [] });
        return await perform();
      } finally {
        importing = false;
      }
    },
    status,
    detect,
    history,
    invalidate() {
      if (sync.enabled && submitting) pause('连接中断，同步已暂停。请核对导入历史后重新开启。');
      revision++;
      selection = undefined;
    },
    async import(input: { readonly selectionId: string; readonly projectKeys: readonly string[] }) {
      if (sync.pending) {
        if (!(await history()).some((record) => record.id === sync.pending?.id))
          throw new MemoryImportRefusal('同步结果尚未确认，请核对导入历史后再试。');
        const { pending: _pending, ...rest } = sync;
        save(rest);
      }
      if (importing || checking) throw new MemoryImportRefusal('正在导入或同步，请等待结果。');
      if (
        !input ||
        !Array.isArray(input.projectKeys) ||
        input.projectKeys.some((key) => typeof key !== 'string')
      )
        throw new MemoryImportRefusal('项目选择无效，请重新检测。');
      const keys = [...new Set(input.projectKeys)];
      if (
        !selection ||
        input.selectionId !== selection.id ||
        !keys.length ||
        keys.some((key) => !selection!.keys.has(key))
      )
        throw new MemoryImportRefusal('项目选择已失效，请重新检测。');
      selection = undefined;
      importing = true;
      let writeStarted = false;
      try {
        const state = await status();
        if (!state.supported) throw new MemoryImportRefusal(state.reason);
        const response = await request<{ readonly items: readonly MigrationItem[] }>(
          METHOD.externalAgentDetect,
          { includeHome: true },
        );
        const available = new Set(
          response.items
            .filter((item) => item.itemType === 'MEMORY')
            .flatMap((item) => item.details?.memory ?? []),
        );
        if (keys.some((key) => !available.has(key)))
          throw new MemoryImportRefusal('来源项目已变化或已导入，请重新检测后选择。');
        // Construct the sole allowed migration type. Never accept renderer-supplied config/items.
        writeStarted = true;
        return await request<{ readonly importId: string }>(METHOD.externalAgentImport, {
          migrationItems: [
            {
              itemType: 'MEMORY',
              description: '导入项目记忆',
              cwd: null,
              details: { memory: keys },
            },
          ],
          source: 'evowork',
          providerId: 'claude-code',
        });
      } catch (error) {
        if (!writeStarted)
          throw error instanceof MemoryImportRefusal
            ? error
            : new MemoryImportRefusal('导入前无法核对来源状态，请重新检测。');
        throw error;
      } finally {
        importing = false;
      }
    },
  };
}
