import { createHash } from 'node:crypto';
/** Public JSON-RPC metadata only; never inspect native private state. */
export async function inspectHookDiagnostics(adapter) {
  const listed = await adapter.session.peer.request('hooks/list', {});
  return {
    activeBundledCount: adapter.bundledHooksActive(),
    rootKeys: Object.keys(listed),
    groups: (listed.data ?? []).map((entry) => ({
      fields: Object.keys(entry),
      hooks: (entry.hooks ?? []).map((h) => ({
        key: h.key,
        sourcePath: h.sourcePath,
        handlerType: h.handlerType,
        enabled: h.enabled,
        trustStatus: h.trustStatus,
        hasCurrentHash: typeof h.currentHash === 'string',
        commandHash:
          typeof h.command === 'string'
            ? createHash('sha256').update(h.command).digest('hex')
            : null,
      })),
    })),
  };
}
