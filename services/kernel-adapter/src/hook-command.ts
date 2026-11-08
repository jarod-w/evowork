import { Buffer } from 'node:buffer';

/**
 * 宿主写给内核的 hook 命令是不是在跑某个随包脚本。
 *
 * POSIX 把脚本路径留在命令明文里。Windows 为了固定 UTF-8 和退出码，把整段
 * PowerShell 放进 `-EncodedCommand` 的 UTF-16LE Base64，明文里只剩 powershell.exe。
 * 只在明文里找 `post-tool-use.mjs` 会把已经受信任的写入回执判成不存在，
 * WorkBuddy 的「预览并继续」因此在所有 Windows 上一直禁用。
 */
export function commandRunsBundledScript(command: string, scriptFile: string): boolean {
  if (command.includes(scriptFile)) return true;
  const marker = '-EncodedCommand ';
  const at = command.indexOf(marker);
  if (at < 0) return false;
  const payload =
    command
      .slice(at + marker.length)
      .trim()
      .split(/\s+/u)[0] ?? '';
  if (payload.length === 0) return false;
  return Buffer.from(payload, 'base64').toString('utf16le').includes(scriptFile);
}
