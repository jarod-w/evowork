import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  makeTempDir,
  parseFailure,
  removeDir,
  runPython,
  writeContent,
} from '../../_shared/test-helpers.js';

const CHECK = resolve(dirname(fileURLToPath(import.meta.url)), '../container_tools/check.py');

let dir: string;
beforeEach(() => {
  dir = makeTempDir('evowork-mail-');
});
afterEach(() => removeDir(dir));

const GOOD = {
  to: ['财务部'],
  subject: '请确认预算',
  body: '请看合计行。',
  ask: '确认预算金额',
};

function run(content: unknown, out = '邮件草稿.md') {
  return runPython(CHECK, ['--content', writeContent(dir, content), '--out', join(dir, out)]);
}

describe('邮件只出草稿', () => {
  it('写出收件人、主题和要对方做的事', () => {
    expect(run(GOOD).status).toBe(EXIT.ok);
    const text = readFileSync(join(dir, '邮件草稿.md'), 'utf8');
    expect(text).toContain('收件人：财务部');
    expect(text).toContain('主题：请确认预算');
    expect(text).toContain('要对方做的事：确认预算金额');
  });

  it('带发送或凭据字段时拒绝，不写出文件', () => {
    for (const field of ['send', 'smtp', 'deliver', 'password', 'token']) {
      const result = run({ ...GOOD, [field]: true });
      expect(result.status, field).toBe(EXIT.invalidContent);
      expect(parseFailure(result.stderr).message).toContain('自己发');
      expect(result.stderr).not.toContain('请确认预算');
      expect(existsSync(join(dir, '邮件草稿.md')), field).toBe(false);
    }
  });

  it('没有要对方做的事时拒绝', () => {
    const { ask: _ask, ...rest } = GOOD;
    expect(run(rest).status).toBe(EXIT.invalidContent);
  });
});
