import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

it('办公工具标准输出和错误输出始终为 UTF-8，即使宿主环境使用 GBK', () => {
  const python =
    process.env.EVOWORK_OFFICE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const script = [
    'import sys,json',
    `sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, '../../_shared'))})`,
    'import evowork_skill',
    'print(json.dumps({"\\u4e2d\\u6587":"\\u5185\\u5bb9"},ensure_ascii=False))',
    'print("\\u9519\\u8bef\\u7ec6\\u8282",file=sys.stderr)',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '0', PYTHONIOENCODING: 'gbk' },
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ 中文: '内容' });
  expect(result.stderr.trim()).toBe('错误细节');
});

it('切换办公解释器要等待执行完成，并保留标准输出、错误输出与失败退出码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evowork-reexec-'));
  try {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const script = join(dir, 'switch.py');
    writeFileSync(
      script,
      [
        'import sys, time',
        `sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dirname, '../../_shared'))})`,
        'import evowork_skill as e',
        'e.ensure_office_runtime(["evowork_nonexistent_reexec_test_module"])',
        'time.sleep(0.2)',
        'print("runtime-ready", flush=True)',
        'print("runtime-check", file=sys.stderr, flush=True)',
        'sys.exit(7)',
      ].join('\n'),
    );
    const { EVOWORK_SKILL_REEXEC: _reexec, ...env } = process.env;
    // The current interpreter is enough: the absent module forces one real switch,
    // and the existing re-entry guard lets that child reach the observable result.
    const interpreter = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    expect(interpreter.status, interpreter.stderr).toBe(0);
    const result = spawnSync(python, [script], {
      encoding: 'utf8',
      env: { ...env, EVOWORK_OFFICE_PYTHON: interpreter.stdout.trim() },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout.trim()).toBe('runtime-ready');
    expect(result.stderr.trim()).toBe('runtime-check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
