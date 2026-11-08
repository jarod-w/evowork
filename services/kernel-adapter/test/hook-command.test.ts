import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { commandRunsBundledScript } from '../src/hook-command.js';

function windowsHook(scriptFile: string): string {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::In.ReadToEnd() | & 'C:\\Program Files\\EvoWork\\EvoWork.exe' " +
      `'D:\\EvoWork\\plugins\\hooks\\evowork-policy\\bin\\${scriptFile}'`,
  ].join('\n');
  return (
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe ' +
    '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' +
    Buffer.from(script, 'utf16le').toString('base64')
  );
}

describe('随包 hook 命令认脚本', () => {
  it('POSIX 明文路径按文件名区分', () => {
    const post =
      "ELECTRON_RUN_AS_NODE=1 '/App/EvoWork' '/App/plugins/hooks/evowork-policy/bin/post-tool-use.mjs'";
    const pre = post.replace('post-tool-use.mjs', 'pre-tool-use.mjs');
    expect(commandRunsBundledScript(post, 'post-tool-use.mjs')).toBe(true);
    expect(commandRunsBundledScript(pre, 'post-tool-use.mjs')).toBe(false);
  });

  it('Windows 的 EncodedCommand 要解开之后才看得到脚本名', () => {
    const post = windowsHook('post-tool-use.mjs');
    const pre = windowsHook('pre-tool-use.mjs');
    expect(post.includes('post-tool-use.mjs')).toBe(false);
    expect(commandRunsBundledScript(post, 'post-tool-use.mjs')).toBe(true);
    expect(commandRunsBundledScript(pre, 'post-tool-use.mjs')).toBe(false);
  });
});
