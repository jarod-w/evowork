import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { extractLibraryBody } from '../src/library-extract.js';
import { resolveOfficeInterpreter } from '../src/probe.js';
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'evowork-body-extract-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('body extraction does not stop at the attachment summary and exposes character truncation', async () => {
  const path = join(root, 'notes.txt');
  writeFileSync(path, 'first ' + 'a'.repeat(25000) + ' 后部合同');
  const result = await extractLibraryBody({ path });
  expect(result.blocks.map((b) => b.text).join('')).toContain('后部合同');
  expect(result.partial).toBe(false);
  writeFileSync(path, 'x'.repeat(2_100_000));
  const large = await extractLibraryBody({ path });
  expect(large.partial).toBe(true);
  expect(large.characters).toBeLessThanOrEqual(2_000_000);
});
it('spreadsheet indexing includes row 201 and keeps sheet/row anchors, or reports the genuinely missing runtime', async () => {
  const path = join(root, 'rows.xlsx'),
    interpreter = resolveOfficeInterpreter();
  if (!interpreter || process.platform !== 'darwin') {
    writeFileSync(path, 'not decoded');
    await expect(
      extractLibraryBody({ path, interpreter: join(root, 'missing-python') }),
    ).rejects.toThrow();
    return;
  }
  execFileSync(interpreter, [
    '-c',
    "import openpyxl,sys;w=openpyxl.Workbook();s=w.active;[s.append([i,'后部合同' if i==201 else '普通记录']) for i in range(1,241)];w.save(sys.argv[1])",
    path,
  ]);
  const result = await extractLibraryBody({ path, interpreter });
  expect(result.partial).toBe(false);
  const block = result.blocks.find((b) => b.text.includes('后部合同'));
  expect(block?.location).toContain('201');
});
