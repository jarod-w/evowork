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

export interface MemoryImportStatus {
  readonly supported: boolean;
  readonly reason?: string;
  readonly history: readonly MemoryImportHistory[];
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
export function createMemoryImporter(peer: () => JsonRpcPeer) {
  let selection: { id: string; keys: Set<string> } | undefined;
  let importing = false;

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

  async function history(): Promise<readonly MemoryImportHistory[]> {
    const response = await request<{ readonly data: readonly ImportRecord[] }>(
      METHOD.externalAgentImportHistoriesRead,
    );
    return response.data
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
      return config.config.features?.external_agent_memory_import === true
        ? { supported: true, history: records }
        : { supported: false, reason: '当前配置未开启外部记忆导入。', history: records };
    } catch (error) {
      if (error instanceof JsonRpcCallError && error.code === ERROR_CODE.methodNotFound)
        return {
          supported: false,
          reason: '当前版本不支持项目记忆导入，请更新应用。',
          history: [],
        };
      throw new Error('无法读取导入状态，请稍后重试。');
    }
  }

  async function detect(): Promise<MemoryImportDetection> {
    if (importing) throw new Error('正在导入，请等待结果后重新检测。');
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

  return {
    status,
    detect,
    history,
    invalidate() {
      selection = undefined;
    },
    async import(input: { readonly selectionId: string; readonly projectKeys: readonly string[] }) {
      if (importing) throw new MemoryImportRefusal('正在导入，请等待结果。');
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
