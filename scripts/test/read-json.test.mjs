import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readJsonFile } from '../../apps/desktop/test/e2e/harness/read-json.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(body) {
  const dir = mkdtempSync(join(tmpdir(), 'evowork-json-oracle-'));
  dirs.push(dir);
  const path = join(dir, 'result.json');
  writeFileSync(path, body);
  return path;
}
it('accepts Windows UTF-8 BOM files without changing Chinese text or numeric results', () => {
  expect(readJsonFile(file('﻿{"标题":"复盘","change":-0.004}'))).toEqual({
    标题: '复盘',
    change: -0.004,
  });
});
it('preserves an embedded BOM and ordinary JSON values', () => {
  expect(readJsonFile(file('{"value":"a﻿b","ok":true}'))).toEqual({ value: 'a﻿b', ok: true });
});
it.each(['﻿﻿{}', '﻿{"value":}', 'not JSON'])('still rejects malformed JSON: %j', (body) => {
  expect(() => readJsonFile(file(body))).toThrow(SyntaxError);
});
