import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function windowsProcesses() {
  const result = spawnSync(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 5000 },
  );
  if (result.error || result.status !== 0)
    throw new Error('Cannot verify owned application process metadata');
  const data = JSON.parse(result.stdout);
  return (Array.isArray(data) ? data : [data]).map((row) => ({
    pid: row.ProcessId,
    parentPid: row.ParentProcessId,
    createdAt: row.CreationDate,
  }));
}

function descendantPids(rows, seeds) {
  const pids = new Set(seeds);
  let changed;
  do {
    changed = false;
    for (const row of rows)
      if (pids.has(row.parentPid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
  } while (changed);
  return pids;
}

/** Windows whole-app force quit, restricted to the Electron child owned by this test. */
export async function terminateTestAppTree(child, knownPids = []) {
  const rootPid = child.pid;
  if (
    !Number.isSafeInteger(rootPid) ||
    rootPid <= 1 ||
    rootPid === process.pid ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    throw new Error('Expected the live Electron child owned by this test');
  const windows = process.platform === 'win32';
  let verified = [
    rootPid,
    ...(windows ? knownPids.filter((pid) => Number.isSafeInteger(pid) && pid > 1) : []),
  ];
  if (verified.includes(process.pid))
    throw new Error('Test runner cannot be an application descendant');
  let taskkillExitCode;
  let ownedProcessTree;
  if (windows) {
    const before = windowsProcesses();
    if (before.find((row) => row.pid === rootPid)?.parentPid !== process.pid)
      throw new Error('Application root is not a child of this test worker');
    const owned = descendantPids(before, [rootPid]);
    for (const pid of verified)
      if (!owned.has(pid)) throw new Error('Known application process is outside the owned tree');
    ownedProcessTree = before.filter((row) => owned.has(row.pid));
    const result = spawnSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(rootPid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 15000 },
    );
    taskkillExitCode = result.status;
    if (result.error || !Number.isInteger(result.status))
      throw new Error(
        'Owned application process-tree termination failed: ' +
          JSON.stringify({
            rootPid,
            knownPids,
            status: result.status,
            signal: result.signal,
            errorCode: result.error?.code,
          }),
      );
    // taskkill may return nonzero when descendants exit during its traversal.
    // Keep its status, but require the stronger observable result: every owned
    // process, including newly observed descendants of those PIDs, has exited.
    verified = [...descendantPids(windowsProcesses(), [...owned])];
  } else if (!child.kill('SIGKILL')) throw new Error('Owned application termination failed');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      (child.exitCode !== null || child.signalCode !== null) &&
      verified.every((pid) => !alive(pid))
    )
      return {
        method: windows ? 'taskkill-owned-tree' : 'SIGKILL',
        rootPid,
        verifiedExitedPids: [...new Set(verified)],
        completedAt: Date.now(),
        ...(windows ? { taskkillExitCode, ownedProcessTree } : {}),
        allObservedExited: true,
        exit: { code: child.exitCode, signal: child.signalCode },
      };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Owned application processes are still alive after forced termination');
}
