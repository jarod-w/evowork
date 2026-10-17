import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createFileJournal, isIgnored } from '@evowork/artifacts';
import type { Adapter, UiEvent } from '@evowork/kernel-adapter';
import type { Store } from '@evowork/store';
import type { RendererEvent } from '../shared/ipc.js';

export function createFileHost(options: {
  directory: string;
  store: Store;
  adapter: () => Adapter;
  pluginsDir?: string | undefined;
  configPath: string;
  emit: (event: RendererEvent) => void;
  register: (threadId: string, path: string) => void;
}) {
  let token = randomBytes(32).toString('base64url');
  const journal = createFileJournal({
    directory: options.directory,
    rootOf: (id) => options.store.threads.get(id)?.cwd ?? undefined,
    busy: (root) =>
      options.store.threads.queryThreadIds({ limit: 10000 }).some((id) => {
        const row = options.store.threads.get(id);
        if (!row?.cwd || row.last_turn_status !== 'inProgress') return false;
        try {
          const path = realpathSync(row.cwd),
            rel = relative(root, path),
            inverse = relative(path, root);
          const inside = (part: string) =>
            part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
          return inside(rel) || inside(inverse);
        } catch {
          return true;
        }
      }),
  });
  const changed = (threadId: string) =>
    options.emit({ type: 'task-results-updated', taskId: threadId });
  const failures = new Map<string, string>();
  const watchers = new Map<
    string,
    { watcher: FSWatcher; tasks: Set<string>; timer?: ReturnType<typeof setTimeout> }
  >();
  function watchTask(threadId: string) {
    const cwd = options.store.threads.get(threadId)?.cwd;
    if (!cwd) return;
    const root = realpathSync(cwd),
      existing = watchers.get(root);
    if (existing) {
      existing.tasks.add(threadId);
      return;
    }
    const tasks = new Set([threadId]);
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && isIgnored(filename.toString())) return;
      const record = watchers.get(root);
      if (!record) return;
      if (record.timer) clearTimeout(record.timer);
      record.timer = setTimeout(() => {
        for (const id of tasks) changed(id);
      }, 150);
    });
    watcher.on('error', () => {
      for (const id of tasks) failures.set(id, '工作目录监听已中断，重新打开任务可刷新文件。');
    });
    watchers.set(root, { watcher, tasks });
  }
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/call' ||
      request.headers.authorization !== 'Bearer ' + token
    ) {
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (part: Buffer) => {
      size += part.length;
      if (size > 65536) request.destroy();
      else chunks.push(part);
    });
    request.on('end', () => {
      try {
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          threadId: string;
          sessionId: string;
          name: string;
          arguments: Record<string, unknown>;
        };
        if (
          typeof call.threadId !== 'string' ||
          typeof call.sessionId !== 'string' ||
          !['list_files', 'register_file', 'open_file'].includes(call.name) ||
          !call.arguments ||
          typeof call.arguments !== 'object' ||
          Object.keys(call.arguments).some(
            (key) => key !== (call.name === 'list_files' ? 'cursor' : 'path'),
          ) ||
          !options.adapter().resolveWorkspaceFileToolCall(call.threadId, call.name, call.arguments)
        )
          throw new Error('文件调用身份不可用。');
        let result: unknown;
        if (call.name === 'list_files') {
          const cursor = call.arguments.cursor ?? '0';
          if (typeof cursor !== 'string' || !/^\d{1,6}$/.test(cursor))
            throw new Error('文件列表游标无效。');
          const view = journal.view(call.threadId),
            offset = Number(cursor);
          const files = new Map(
            view?.files.map((file) => [file.path, { ...file, kind: 'unchanged' }]) ?? [],
          );
          for (const change of view?.thread ?? [])
            files.set(change.path, { path: change.path, source: change.source, kind: change.kind });
          const entries = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
          result = {
            files: entries.slice(offset, offset + 100),
            nextCursor: offset + 100 < entries.length ? String(offset + 100) : null,
            warnings: view?.warnings ?? ['尚未建立任务文件记录。'],
          };
        } else {
          if (typeof call.arguments.path !== 'string' || !call.arguments.path.trim())
            throw new Error('缺少文件路径。');
          const path = journal.safeFile(call.threadId, call.arguments.path);
          if (call.name === 'register_file') {
            journal.claim(call.threadId, path);
            options.register(call.threadId, path);
            changed(call.threadId);
          } else
            options.emit({
              type: 'file-open-requested',
              taskId: call.threadId,
              path,
              requestId: randomUUID(),
            });
          result = { ok: true, path };
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(
            JSON.stringify({ error: error instanceof Error ? error.message : '文件操作失败。' }),
          );
      }
    });
  });
  const ready = new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  ready.catch(() => undefined);
  if (options.pluginsDir) {
    const original = existsSync(options.configPath) ? readFileSync(options.configPath, 'utf8') : '';
    let skip = false;
    const kept = original.split('\n').filter((line) => {
      const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
      if (section)
        skip =
          section === 'mcp_servers.workspace_files' ||
          section.startsWith('mcp_servers.workspace_files.');
      return !skip;
    });
    writeFileSync(
      options.configPath,
      kept.join('\n').trimEnd() +
        '\n\n[mcp_servers.workspace_files]\ncommand = ' +
        JSON.stringify(process.execPath) +
        '\nargs = [' +
        JSON.stringify(join(options.pluginsDir, 'connectors/workspace-files/server.mjs')) +
        ']\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenv_vars = ["EVOWORK_FILES_ENDPOINT", "EVOWORK_FILES_TOKEN"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 30\ndefault_tools_approval_mode = "approve"\n',
      { mode: 0o600 },
    );
  }
  return {
    journal,
    ready,
    changed,
    view(threadId: string) {
      try {
        watchTask(threadId);
        const view = journal.view(threadId);
        const failure = failures.get(threadId);
        return failure
          ? {
              ...(view ?? { turnId: '', thread: [], turn: [], files: [] }),
              warnings: [...(view?.warnings ?? []), failure],
            }
          : view;
      } catch {
        return {
          turnId: '',
          thread: [],
          turn: [],
          files: [],
          warnings: ['文件记录暂时无法读取，未承诺可撤销。'],
        };
      }
    },
    onEvent(event: UiEvent) {
      if (!('threadId' in event)) return;
      try {
        if (event.type === 'turn-started') {
          journal.begin(event.threadId, event.turnId);
          watchTask(event.threadId);
        }
        if (
          event.type === 'item-completed' &&
          ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.item.type)
        ) {
          journal.capture(event.threadId);
          if (event.item.type === 'fileChange' && Array.isArray(event.item.changes)) {
            for (const change of event.item.changes as { path: string }[])
              journal.claim(event.threadId, change.path);
          }
          changed(event.threadId);
        }
        if (event.type === 'turn-completed') {
          journal.finish(event.threadId);
          changed(event.threadId);
        }
      } catch {
        failures.set(event.threadId, '部分文件记录未完成，不能保证完整差异和磁盘撤销。');
        changed(event.threadId);
      }
    },
    get environment() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('本机文件服务尚未就绪。');
      return {
        EVOWORK_FILES_ENDPOINT: `http://127.0.0.1:${address.port}/call`,
        EVOWORK_FILES_TOKEN: token,
      };
    },
    rotate() {
      token = randomBytes(32).toString('base64url');
      journal.stop();
    },
    close() {
      for (const record of watchers.values()) {
        if (record.timer) clearTimeout(record.timer);
        record.watcher.close();
      }
      watchers.clear();
      journal.stop();
      server.closeAllConnections();
      server.close();
    },
  };
}
