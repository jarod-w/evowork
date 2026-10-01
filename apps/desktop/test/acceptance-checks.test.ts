/**
 * 验收用例的**判定函数**自检（`test/e2e/harness/acceptance/selftest.py`）。
 *
 * 真模型验收（`acceptance.real.spec.mjs`）一轮要跑几十分钟，判定函数若写错，
 * 每一轮都会被判错 —— 而那看起来和「模型做错了」一模一样。所以判定本身放进 check：
 * 每个用例一份对的产出必须 PASS、一份错的必须 FAIL。
 *
 * 需要办公扩展的 python（夹具要 python-docx / openpyxl / matplotlib）。没装就不跑，
 * 并在输出里说一声 —— CI 上没有办公扩展，这条在 CI 永远不跑，本地装了才验得到。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const PYTHON =
  process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
const SELFTEST = resolve(import.meta.dirname, 'e2e/harness/acceptance/selftest.py');

describe('外部验收用例的判定函数', () => {
  it.runIf(existsSync(PYTHON))(
    '对的产出判 PASS、错的判 FAIL（含测试方原版的两处误判已修）',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'evowork-acceptance-'));
      try {
        const out = execFileSync(PYTHON, [SELFTEST, dir], { encoding: 'utf8' });
        expect(out.trim()).toBe('selftest ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
