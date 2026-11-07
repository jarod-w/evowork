/**
 * 宿主装进内核的两样策略件：模式指令的升级、策略 hook 的 hooks.json。
 *
 * 两者都是 2026-09-28 外部测试复现时发现的「写好了但到不了用户」：
 * 模式指令改了只对新装机器生效；策略 hook 从没被内核加载过。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureKernelHooks,
  ensureModeInstructions,
  ensurePaths,
  resolvePaths,
} from '../src/main/service-host.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-install-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('模式指令：没被改过的旧版升级，改过的保留', () => {
  function setup(installed: string) {
    const configDir = join(dir, 'config');
    mkdirSync(join(configDir, 'modes'), { recursive: true });
    writeFileSync(join(configDir, 'modes', 'craft.md'), '新版\n');
    writeFileSync(
      join(configDir, 'modes', 'shipped.json'),
      JSON.stringify({ versions: { 'craft.md': [sha('旧版\n'), sha('新版\n')] } }),
    );
    const paths = resolvePaths(join(dir, 'home'));
    ensurePaths(paths);
    mkdirSync(paths.modes, { recursive: true });
    writeFileSync(join(paths.modes, 'craft.md'), installed);
    return { paths, configDir };
  }

  it('装着的是我们发过的旧版 → 换成新版（以前「已存在不覆盖」，修订永远到不了已装用户）', () => {
    const { paths, configDir } = setup('旧版\n');
    expect(ensureModeInstructions(paths, configDir)).toBe(1);
    expect(readFileSync(join(paths.modes, 'craft.md'), 'utf8')).toBe('新版\n');
  });

  it('装着的被用户或企业改过 → 原样保留', () => {
    const { paths, configDir } = setup('企业自己写的 Craft 指令\n');
    expect(ensureModeInstructions(paths, configDir)).toBe(0);
    expect(readFileSync(join(paths.modes, 'craft.md'), 'utf8')).toBe('企业自己写的 Craft 指令\n');
  });

  it('Windows 换行不等于用户修改，未改内容的旧模式仍能升级', () => {
    const { paths, configDir } = setup('旧版\r\n');
    expect(ensureModeInstructions(paths, configDir)).toBe(1);
    expect(readFileSync(join(paths.modes, 'craft.md'), 'utf8')).toBe('新版\n');
  });

  it('**仓库里每个模式文件的当前版本都登记在 shipped.json 里** —— 否则下次升级认不出它', () => {
    const modes = join(ROOT, 'config', 'modes');
    const shipped = JSON.parse(readFileSync(join(modes, 'shipped.json'), 'utf8')) as {
      versions: Record<string, string[]>;
    };
    for (const name of readdirSync(modes).filter((n) => n.endsWith('.md'))) {
      expect(shipped.versions[name], `${name} 改过之后要把新哈希加进 shipped.json`).toContain(
        sha(readFileSync(join(modes, name), 'utf8')),
      );
    }
  });
});

describe('策略 hook 装进内核目录的 hooks.json', () => {
  it('形状是内核的 HooksFile（事件包在 hooks 里），随包清单里的每个事件都在', () => {
    const paths = resolvePaths(join(dir, 'home'));
    ensurePaths(paths);
    const result = ensureKernelHooks(paths, {
      pluginsDir: join(ROOT, 'plugins'),
      execPath:
        process.platform === 'win32'
          ? process.execPath
          : '/Applications/EvoWork.app/Contents/MacOS/EvoWork',
    });
    expect(result).toBeDefined();
    const written = JSON.parse(readFileSync(result!.sourcePath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const plugin = JSON.parse(
      readFileSync(join(ROOT, 'plugins/hooks/evowork-policy/hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    // 事件放在顶层会被内核解析成空集并**静默丢掉** —— 所以断言的是 `hooks` 里有全部事件
    expect(Object.keys(written.hooks).sort()).toEqual(Object.keys(plugin.hooks).sort());
    for (const command of result!.commands) {
      // 配置层 hook 没有 CLAUDE_PLUGIN_ROOT；用户机器上也没有 node
      expect(command).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      if (process.platform !== 'win32')
        expect(command).toMatch(/^ELECTRON_RUN_AS_NODE=1 '\/Applications\/EvoWork\.app/);
    }
  });

  it.runIf(process.platform !== 'win32')(
    '路径里有空格和单引号也能被 shell 原样拿到（内核用 $SHELL -lc 跑它）',
    () => {
      const paths = resolvePaths(join(dir, 'home'));
      ensurePaths(paths);
      const weird = join(dir, "My Apps's", 'bin');
      mkdirSync(weird, { recursive: true });
      const echoArgs = join(weird, 'echo-args');
      writeFileSync(echoArgs, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', {
        mode: 0o755,
      });
      const result = ensureKernelHooks(paths, {
        pluginsDir: join(ROOT, 'plugins'),
        execPath: echoArgs,
      });
      const printed = execFileSync('/bin/sh', ['-c', result!.commands[0]!]).toString().trim();
      expect(printed).toMatch(/plugins\/hooks\/evowork-policy\/bin\/.+\.mjs$/);
    },
  );
});

it.runIf(process.platform === 'win32')(
  'Windows hook 经真实命令解释器保留特殊路径、UTF-8 输入输出和成功失败状态',
  () => {
    const paths = resolvePaths(join(dir, 'home'));
    ensurePaths(paths);
    const pluginsDir = join(dir, "应用 空格's %EVOWORK_ABSENT% &", 'plugins');
    const plugin = join(pluginsDir, 'hooks', 'evowork-policy');
    mkdirSync(join(plugin, 'bin'), { recursive: true });
    const script = join(plugin, 'bin', 'probe.mjs');
    writeFileSync(
      script,
      [
        'const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);',
        "const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));",
        'console.log(JSON.stringify({value,script:process.argv[1],asNode:process.env.ELECTRON_RUN_AS_NODE}));',
        'process.exitCode=value.exitCode;',
      ].join('\n'),
    );
    writeFileSync(
      join(plugin, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: 'node ${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs' }] }],
        },
      }),
    );
    const result = ensureKernelHooks(paths, { pluginsDir, execPath: process.execPath });
    expect(result).toBeDefined();
    for (const shell of ['cmd', 'powershell']) {
      for (const exitCode of [0, 7]) {
        const value = { text: '中文、引号"与换行\n均应保持', exitCode };
        const actual = spawnSync(
          shell === 'cmd'
            ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
            : join(
                process.env.SystemRoot ?? 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
              ),
          shell === 'cmd'
            ? ['/C', '"' + result!.commands[0] + '"']
            : ['-NoProfile', '-NonInteractive', '-Command', result!.commands[0]!],
          {
            windowsVerbatimArguments: shell === 'cmd',
            windowsHide: true,
            input: JSON.stringify(value),
            encoding: 'utf8',
            timeout: 5000,
          },
        );
        expect(actual.error).toBeUndefined();
        // PowerShell -Command normalizes a child failure to 1; CMD preserves its code.
        expect(actual.status, actual.stderr).toBe(
          shell === 'powershell' && exitCode !== 0 ? 1 : exitCode,
        );
        expect(JSON.parse(actual.stdout.trim())).toEqual({ value, script, asNode: '1' });
      }
    }
  },
);

it.runIf(process.platform === 'win32')('Windows 随包策略程序真实拒绝凭据命令并落审计', () => {
  const paths = resolvePaths(join(dir, 'home'));
  ensurePaths(paths);
  const hooks = ensureKernelHooks(paths, {
    pluginsDir: join(ROOT, 'plugins'),
    execPath: createRequire(import.meta.url)('electron'),
  });
  const manifest = JSON.parse(readFileSync(hooks!.sourcePath, 'utf8'));
  const command = manifest.hooks.PreToolUse[0].hooks[0].command;
  const input = {
    session_id: 'policy-probe',
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'probe-call',
    permission_mode: 'default',
    tool_input: { command: 'cat ~/.ssh/evowork-canary-absent' },
  };
  const actual = spawnSync(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, EVOWORK_AUDIT_LOG: paths.auditLog },
    },
  );
  expect(actual.status, actual.stderr).toBe(0);
  expect(actual.stdout, actual.stderr).not.toBe('');
  expect(JSON.parse(actual.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  const records = readFileSync(paths.auditLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.some((record) => record.pathKind === 'credentials')).toBe(true);
});
