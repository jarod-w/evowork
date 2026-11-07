import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Read-only process/TCP metadata. Never records headers, payloads, or command lines. */
export function startWindowsEgressSampler(rootPid, identities = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error('Invalid sampler root PID');
  const directory = mkdtempSync(join(tmpdir(), 'evowork-egress-'));
  const stopFile = join(directory, 'stop');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Sample-Connections {
  try {
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name)
    $owners = [Collections.Generic.HashSet[int]]::new()
    $null = $owners.Add(__ROOT__)
    do {
      $added = $false
      foreach ($entry in $processes) {
        if ($owners.Contains([int]$entry.ParentProcessId) -and $owners.Add([int]$entry.ProcessId)) { $added = $true }
      }
    } while ($added)
    $labels = @{}
    foreach ($entry in $processes) {
      $label = if ($entry.ProcessId -eq __KERNEL__) { 'kernel' }
        elseif ($entry.ProcessId -eq __GATEWAY__) { 'gateway' }
        elseif ($entry.ProcessId -eq __ROOT__) { 'electron' } else { 'agent-process' }
      $labels[[int]$entry.ProcessId] = $label
    }
    $connections = @(Get-NetTCPConnection)
    $rows = @($connections | Where-Object { $_.State -eq 'Established' -and $owners.Contains([int]$_.OwningProcess) } | ForEach-Object {
      $address = [string]$_.RemoteAddress
      if ($address.Contains(':')) { $address = '[' + $address + ']' }
      @{ remote = $address + ':' + $_.RemotePort; pid = [int]$_.OwningProcess; owner = $labels[[int]$_.OwningProcess] }
    })
    [Console]::Out.WriteLine((@{ type = 'sample'; rows = $rows } | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::Out.WriteLine((@{ type = 'error'; name = $_.Exception.GetType().Name } | ConvertTo-Json -Compress))
  }
}
$stopFile = '__STOP__'
while (-not (Test-Path -LiteralPath $stopFile) -and (Get-Process -Id __PARENT__ -ErrorAction SilentlyContinue)) { Sample-Connections; Start-Sleep -Milliseconds 500 }
Sample-Connections
`
    .replaceAll('__ROOT__', String(rootPid))
    .replace('__STOP__', stopFile.replaceAll("'", "''"))
    .replace('__PARENT__', String(process.pid))
    .replaceAll(
      '__KERNEL__',
      String(Number.isInteger(identities.kernelPid) ? identities.kernelPid : -1),
    )
    .replaceAll(
      '__GATEWAY__',
      String(Number.isInteger(identities.gatewayPid) ? identities.gatewayPid : -1),
    );
  const command = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const child = spawn(
    command,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let buffer = '',
    samples = 0,
    readyResolve,
    readyReject;
  const errors = [],
    seen = new Set(),
    who = new Map();
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === 'error') {
          errors.push(record.name);
          readyReject(new Error('Windows TCP observation unavailable'));
          continue;
        }
        samples += 1;
        for (const row of record.rows ?? []) {
          seen.add(row.remote);
          const owners = who.get(row.remote) ?? new Set();
          owners.add(`${row.owner} · pid ${row.pid}`);
          who.set(row.remote, owners);
        }
        readyResolve();
      } catch {
        errors.push('InvalidSample');
      }
    }
  });
  child.stderr.resume();
  child.once('error', () => {
    errors.push('SamplerSpawnFailed');
    readyReject(new Error('Windows TCP sampler failed to start'));
  });
  const exited = new Promise((resolve) =>
    child.once('close', (code) => {
      readyReject(new Error('Windows TCP sampler closed before readiness'));
      resolve(code);
    }),
  );
  return {
    ready,
    async stop() {
      writeFileSync(stopFile, 'stop');
      let timer;
      const code = await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            child.kill();
            resolve(-1);
          }, 15_000);
        }),
      ]);
      clearTimeout(timer);
      try {
        unlinkSync(stopFile);
        rmdirSync(directory);
      } catch {
        /* Keep unknown files untouched. */
      }
      if (code !== 0 || errors.length || !samples)
        throw new Error(`Windows TCP observation failed: ${errors.join(',') || code}`);
      return {
        remotes: [...seen].sort(),
        owners: Object.fromEntries([...who].map(([remote, owners]) => [remote, [...owners]])),
        samples,
      };
    },
  };
}
