import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/** Observe the public adapter router without persisting commands, paths or IDs. */
export function installApprovalWire(router, path) {
  const original = router.handle;
  let sequence = 0;
  const hash = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  router.handle = async function (method, params) {
    const id = ++sequence;
    appendFileSync(
      path,
      JSON.stringify({
        type: 'request',
        id,
        at: Date.now(),
        requestHash: hash([method, params]),
        actionHash: hash([params?.command, params?.cwd]),
        itemHash: hash([params?.threadId, params?.turnId, params?.itemId, params?.approvalId]),
      }) + '\n',
    );
    try {
      return await original.call(this, method, params);
    } finally {
      appendFileSync(path, JSON.stringify({ type: 'finished', id, at: Date.now() }) + '\n');
    }
  };
  return () => {
    router.handle = original;
  };
}
