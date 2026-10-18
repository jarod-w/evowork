import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFollowUpWire } from '../../apps/desktop/test/e2e/harness/follow-up-wire.mjs';

let home, path;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evowork-wire-test-'));
  path = join(home, 'wire.jsonl');
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});
const url = 'https://api.xiaomimimo.com/v1/chat/completions';
const payload = {
  body: JSON.stringify({
    model: 'mimo-v2.6-flash',
    messages: [{ role: 'user', content: 'private body REALFOLLOW_ONCE_abcdef' }],
  }),
  headers: { authorization: 'Bearer test-secret-never-log' },
};
const rows = () => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);

it('pairs successful HTTP observations without retaining request headers or body', async () => {
  const response = new Response('private response');
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  installFollowUpWire(path);
  expect(await globalThis.fetch(url, payload)).toBe(response);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, payload);
  const data = rows();
  expect(data).toMatchObject([
    { type: 'request', pid: process.pid, id: 1, markers: ['REALFOLLOW_ONCE_abcdef'] },
    { type: 'response', pid: process.pid, id: 1, status: 200 },
  ]);
  expect(readFileSync(path, 'utf8')).not.toMatch(/private body|private response|test-secret/);
});

it('records sanitized transport failures and rethrows the original error without retrying', async () => {
  const error = new TypeError('test-secret-never-log', { cause: { code: 'ECONNRESET' } });
  const fetch = vi.fn().mockRejectedValue(error);
  vi.stubGlobal('fetch', fetch);
  installFollowUpWire(path);
  await expect(globalThis.fetch(url, payload)).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, payload);
  expect(rows()).toMatchObject([
    { type: 'request', pid: process.pid, id: 1 },
    { type: 'transport-error', pid: process.pid, id: 1, name: 'TypeError', code: 'ECONNRESET' },
  ]);
  expect(readFileSync(path, 'utf8')).not.toContain('test-secret');
});

it('redacts arbitrary error metadata and leaves other endpoints unobserved', async () => {
  const error = Object.assign(new Error('secret-message'), {
    name: 'secret-name',
    cause: { code: 'secret-code' },
  });
  const fetch = vi.fn().mockRejectedValue(error);
  vi.stubGlobal('fetch', fetch);
  installFollowUpWire(path);
  await expect(globalThis.fetch('https://example.invalid', payload)).rejects.toBe(error);
  expect(existsSync(path)).toBe(false);
  await expect(globalThis.fetch(url, payload)).rejects.toBe(error);
  expect(rows()[1]).toMatchObject({ type: 'transport-error', name: 'Error', code: null });
  expect(readFileSync(path, 'utf8')).not.toContain('secret');
});
