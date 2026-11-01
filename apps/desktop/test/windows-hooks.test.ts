import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureKernelHooks, ensurePaths, resolvePaths } from '../src/main/service-host.js';

it.skipIf(process.platform !== 'win32')(
  '原生 cmd → PowerShell → hook 的参数、Node 模式与失败退出码保持',
  () => {
    const root = mkdtempSync(join(tmpdir(), "evowork 中文's & %TEMP%! "));
    try {
      const paths = resolvePaths(join(root, 'home'));
      ensurePaths(paths);
      const pluginsDir = join(root, 'plugins'),
        plugin = join(pluginsDir, 'hooks/evowork-policy');
      mkdirSync(join(plugin, 'bin'), { recursive: true });
      writeFileSync(
        join(plugin, 'hooks.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ command: 'node ${CLAUDE_PLUGIN_ROOT}/bin/probe.mjs' }] }],
          },
        }),
      );
      const script = join(plugin, 'bin/probe.mjs');
      writeFileSync(
        script,
        'import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify({path:process.argv[1],node:process.env.ELECTRON_RUN_AS_NODE,input:JSON.parse(readFileSync(0,"utf8"))}));',
      );
      const hook = ensureKernelHooks(paths, { pluginsDir, execPath: process.execPath });
      const output = execFileSync('cmd.exe', ['/d', '/s', '/c', hook!.commands[0]!], {
        encoding: 'utf8',
        input: JSON.stringify({ text: '中文输入输出' }),
      });
      expect(JSON.parse(output)).toEqual({
        path: script,
        node: '1',
        input: { text: '中文输入输出' },
      });
      writeFileSync(script, 'process.exit(19);');
      let exitCode: number | null | undefined;
      try {
        execFileSync('cmd.exe', ['/d', '/s', '/c', hook!.commands[0]!]);
      } catch (error) {
        exitCode = (error as { status: number }).status;
      }
      expect(exitCode).toBe(19);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
