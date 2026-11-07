import { expect, it } from 'vitest';
import { isBoundAttachmentRead } from '../../apps/desktop/test/e2e/harness/attachment-read.mjs';
const file = String.raw`C:\test home\.evowork\workspaces\id\uploads\draft\content.md`;
const shell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const script = "Get-Content -LiteralPath '" + file + "' -Raw";
const display = (text) =>
  '$ ' +
  [shell, '-Command', text]
    .map((x) => (/^[a-zA-Z0-9_./:@=-]+$/.test(x) ? x : JSON.stringify(x)))
    .join(' ');
it('只允许绑定正文的精确只读命令', () => {
  expect(isBoundAttachmentRead(display(script), file, shell)).toBe(true);
});
it.each([
  script + '; Remove-Item C:\\data -Recurse',
  script + ' | Invoke-Expression',
  script + '\nWrite-Output danger',
  script.replace('content.md', 'other.md'),
  script.replace("-LiteralPath '", '-LiteralPath $env:'),
  script + ' -Wait',
  script.replace('Get-Content', 'Set-Content'),
])('拒绝附加操作或不同路径 %s', (text) => {
  expect(isBoundAttachmentRead(display(text), file, shell)).toBe(false);
});
it('拒绝其他解释器与 EncodedCommand', () => {
  expect(
    isBoundAttachmentRead(display(script).replace('powershell.exe', 'pwsh.exe'), file, shell),
  ).toBe(false);
  expect(
    isBoundAttachmentRead(display(script).replace('-Command', '-EncodedCommand'), file, shell),
  ).toBe(false);
});

it.each(['UTF8', 'utf8'])('允许绑定正文的显式 %s 只读命令', (encoding) => {
  expect(isBoundAttachmentRead(display(script + ' -Encoding ' + encoding), file, shell)).toBe(true);
});
it('不能借编码选项附带写入', () => {
  expect(
    isBoundAttachmentRead(display(script + ' -Encoding UTF8; Remove-Item x'), file, shell),
  ).toBe(false);
});
