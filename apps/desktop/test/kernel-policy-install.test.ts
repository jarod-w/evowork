/**
 * 宿主装进内核的两样策略件：模式指令的升级、策略 hook 的 hooks.json。
 *
 * 两者都是 2026-09-28 外部测试复现时发现的「写好了但到不了用户」：
 * 模式指令改了只对新装机器生效；策略 hook 从没被内核加载过。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';

import {
  ensureKernelHooks,
  ensureModeInstructions,
  ensurePaths,
  resolvePaths,
  migrateKernelConfigText,
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

describe.skipIf(process.platform === 'win32')('策略 hook 装进内核目录的 hooks.json', () => {
  it('形状是内核的 HooksFile（事件包在 hooks 里），随包清单里的每个事件都在', () => {
    const paths = resolvePaths(join(dir, 'home'));
    ensurePaths(paths);
    const result = ensureKernelHooks(paths, {
      pluginsDir: join(ROOT, 'plugins'),
      execPath: '/Applications/EvoWork.app/Contents/MacOS/EvoWork',
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
      expect(command).toMatch(/^ELECTRON_RUN_AS_NODE=1 '\/Applications\/EvoWork\.app/);
    }
  });

  it('路径里有空格和单引号也能被 shell 原样拿到（内核用 $SHELL -lc 跑它）', () => {
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
  });
});

it('Windows 也安装所有策略事件，路径里的 shell 字符不成为命令', () => {
  const paths = resolvePaths(join(dir, 'home'));
  ensurePaths(paths);
  const executable = "C:\\Users\\张 三's & %TEMP%!\\EvoWork.exe";
  const result = ensureKernelHooks(paths, {
    pluginsDir: join(ROOT, 'plugins'),
    execPath: executable,
    platform: 'win32',
  });
  expect(result?.commands.length).toBeGreaterThan(0);
  const written = JSON.parse(readFileSync(result!.sourcePath, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  expect(Object.keys(written.hooks)).toContain('PreToolUse');
  for (const command of result!.commands) {
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(command).not.toContain('%TEMP%');
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain("$env:ELECTRON_RUN_AS_NODE='1'");
    expect(script).toContain(executable.replaceAll("'", "''"));
    expect(script).toContain('exit $LASTEXITCODE');
  }
});

it('Windows 启动迁移显式选择上游沙箱，保留已有设置与其它配置', () => {
  for (const text of [
    'model="demo"\n',
    '[windows]\nother=true\n',
    '["windows"]\nother=true\n',
    'windows.other=true\n',
  ]) {
    const once = migrateKernelConfigText(text, 'win32');
    expect((parse(once.text).windows as Record<string, unknown>).sandbox).toBe('elevated');
    expect(migrateKernelConfigText(once.text, 'win32').text).toBe(once.text);
  }
  const explicit = '[windows]\nsandbox="unelevated"\n';
  expect(
    (parse(migrateKernelConfigText(explicit, 'win32').text).windows as Record<string, unknown>)
      .sandbox,
  ).toBe('unelevated');
  expect(parse(migrateKernelConfigText('model="demo"\n', 'darwin').text).windows).toBeUndefined();
});
