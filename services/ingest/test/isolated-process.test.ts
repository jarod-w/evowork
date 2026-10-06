import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parserEnvironment, runIsolatedProcess } from '../src/isolated-process.js';

const directories: string[] = [];
function temporary(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evowork-parser-isolation-')));
  directories.push(dir);
  return dir;
}
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

it('parser environment omits all credentials and proxy variables', () => {
  const saved = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = 'test-credential-not-for-parsers';
  try {
    expect(parserEnvironment('/tmp/parser')).not.toHaveProperty('ARK_API_KEY');
    expect(parserEnvironment('/tmp/parser')).not.toHaveProperty('HTTP_PROXY');
    expect(parserEnvironment('/tmp/parser').HOME).toBe('/tmp/parser');
  } finally {
    if (saved === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = saved;
  }
});

it('OS sandbox permits only approved file content and refuses a real network socket', async () => {
  const dir = temporary();
  const outside = temporary();
  const secret = join(outside, 'private.txt');
  writeFileSync(secret, 'must remain outside parser');
  const result = join(dir, 'result.txt');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local address');
  if (process.platform === 'darwin') {
    const baseline = execFileSync(
      '/usr/bin/perl',
      [
        '-e',
        `use Socket;
      my $read = open(my $file, '<', $ARGV[0]);
      socket(my $sock, PF_INET, SOCK_STREAM, getprotobyname('tcp'));
      my $connected = connect($sock, sockaddr_in($ARGV[1], inet_aton('127.0.0.1')));
      print(($read ? 'read-open' : 'read-denied'), ',', ($connected ? 'network-open' : 'network-denied'));`,
        secret,
        String(address.port),
      ],
      { encoding: 'utf8', env: parserEnvironment(dir) },
    );
    expect(baseline).toBe('read-open,network-open');
  }
  const code = `use Socket;
    open(my $allowed, '>', $ARGV[0]) or die 'allowed write failed'; print $allowed 'allowed'; close $allowed;
    my $read = open(my $outside, '<', $ARGV[1]);
    my $write = open(my $forbidden, '>', $ARGV[1]);
    socket(my $sock, PF_INET, SOCK_STREAM, getprotobyname('tcp'));
    my $network = connect($sock, sockaddr_in($ARGV[2], inet_aton('127.0.0.1')));
    print(($read ? 'read-open' : 'read-denied'), ',', ($write ? 'write-open' : 'write-denied'), ',', ($network ? 'network-open' : 'network-denied'));`;
  const run = runIsolatedProcess({
    executable: '/usr/bin/perl',
    args: ['-e', code, result, secret, String(address.port)],
    readPaths: [],
    writeDirectory: dir,
    timeoutMs: 10_000,
  });
  if (process.platform !== 'darwin') {
    server.close();
    await expect(run).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    return;
  }
  try {
    expect(await run).toBe('read-denied,write-denied,network-denied');
  } finally {
    server.close();
  }
  expect(readFileSync(result, 'utf8')).toBe('allowed');
  expect(readFileSync(secret, 'utf8')).toBe('must remain outside parser');
});

it('deadline kills the entire process group and bounds output', async () => {
  if (process.platform !== 'darwin') {
    await expect(
      runIsolatedProcess({
        executable: '/usr/bin/true',
        args: [],
        readPaths: [],
        writeDirectory: temporary(),
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    return;
  }
  await expect(
    runIsolatedProcess({
      executable: '/usr/bin/perl',
      args: ['-e', 'sleep 60'],
      readPaths: [],
      writeDirectory: temporary(),
      timeoutMs: 100,
    }),
  ).rejects.toMatchObject({ code: 'TIMEOUT' });
  await expect(
    runIsolatedProcess({
      executable: '/usr/bin/perl',
      args: ['-e', 'print "x" x 10000'],
      readPaths: [],
      writeDirectory: temporary(),
      timeoutMs: 5000,
      maxOutputBytes: 100,
    }),
  ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
});

it('cancellation kills forked OCR descendants before they can write a late result', async () => {
  if (process.platform !== 'darwin') {
    await expect(
      runIsolatedProcess({
        executable: '/usr/bin/perl',
        args: [],
        readPaths: [],
        writeDirectory: temporary(),
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    return;
  }
  const dir = temporary();
  const late = join(dir, 'late.txt');
  const pid = join(dir, 'child.pid');
  const started = performance.now();
  await expect(
    runIsolatedProcess({
      executable: '/usr/bin/perl',
      args: [
        '-e',
        `my $pid = fork(); die unless defined $pid;
      if ($pid == 0) { sleep 2; open(my $out, '>', $ARGV[0]); print $out 'late'; close $out; exit 0; }
      open(my $record, '>', $ARGV[1]); print $record $pid; close $record; sleep 60;`,
        late,
        pid,
      ],
      readPaths: [],
      writeDirectory: dir,
      timeoutMs: 1000,
    }),
  ).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(Number(readFileSync(pid, 'utf8'))).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(1900);
  await new Promise<void>((resolve) => setTimeout(resolve, 2100));
  expect(() => readFileSync(late)).toThrow();
});

it('terminates a parser process group when sampled resident memory exceeds its configured budget', async () => {
  await expect(
    runIsolatedProcess({
      executable: '/usr/bin/perl',
      args: ['-e', 'my $large="x" x (128*1024*1024); sleep 3;'],
      readPaths: [],
      writeDirectory: temporary(),
      timeoutMs: 5000,
      maxResidentBytes: 64 * 1024 * 1024,
    }),
  ).rejects.toMatchObject({
    code: process.platform === 'darwin' ? 'MEMORY_LIMIT' : 'SANDBOX_UNAVAILABLE',
  });
});
