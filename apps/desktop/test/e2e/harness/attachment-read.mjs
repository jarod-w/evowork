import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';

/** 只绑定测试刚上传的 content.md；不能从审批命令推断授权路径。 */
export function boundAttachmentPath(bubble, home) {
  const candidate = bubble.match(/正文在 ([^\r\n]+?content\.md)（/)?.[1];
  if (!candidate || !isAbsolute(candidate) || basename(candidate) !== 'content.md') {
    throw new Error('附件说明没有唯一的绝对正文路径');
  }
  const rel = relative(realpathSync(home), realpathSync(candidate));
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    isAbsolute(rel) ||
    !rel.split(sep).includes('uploads')
  )
    throw new Error('附件正文越过测试 HOME/uploads');
  return candidate;
}
const shownArg = (value) => (/^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value));
/** 完整比较 UI argv 表示，不执行、不通用解析 PowerShell。 */
export function isBoundAttachmentRead(shown, attachmentPath, powershellPath) {
  const literal = "'" + attachmentPath.replaceAll("'", "''") + "'";
  const scripts = [
    'Get-Content -LiteralPath ' + literal + ' -Raw',
    'Get-Content -Raw -LiteralPath ' + literal,
  ];
  const utf8Scripts = scripts.flatMap((script) => [
    script,
    script + ' -Encoding UTF8',
    script + ' -Encoding utf8',
  ]);
  const argv = utf8Scripts.flatMap((script) => [
    [powershellPath, '-Command', script],
    [powershellPath, '-NoProfile', '-Command', script],
  ]);
  return argv.some((parts) => shown.trim() === '$ ' + parts.map(shownArg).join(' '));
}
