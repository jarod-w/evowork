/**
 * K5：产品对外不得出现上游品牌。
 *
 * 渲染层里的每一个字符串字面量都可能画到用户眼前，所以扫的是**整个 `src/renderer`**，
 * 而不是某几个页面。2026-10-04 设置页「个性化」的说明与清空确认框里写着
 * 「本机 Codex 记忆」「Codex 已提取的全部本地记忆」—— 类型检查、组件测试、
 * identity 的真模型用例（只看模型回复）都碰不到界面文案，这条之前没有任何一层在看。
 *
 * 注释不算：注释里引用内核概念（`CODEX_HOME`、上游文件名）是必要的，用户也看不见。
 *
 * 「OpenAI 兼容」不在这里拦：它是协议名（设置页让用户选 endpoint 说哪种方言），
 * 能不能这样写等法务给口径（P4-2）。真要禁，在 FORBIDDEN 里加一项，
 * 并给设置页换一个说法 —— 不要在这里开按文件的例外。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RENDERER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer');
const FORBIDDEN = /codex|chatgpt/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|html|css)$/.test(name) ? [path] : [];
  });
}

/**
 * 去掉块注释、JSX 注释与行注释。块注释换成同样多的换行，报出来的行号才对得上。
 * 行注释只认行首或空白后的 `//`，免得把字符串里的 `https://` 当成注释吃掉 ——
 * 那会让 URL 后面的文案漏扫。
 */
function withoutComments(source: string): string {
  const keepNewlines = (comment: string): string => comment.replace(/[^\n]/g, '');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines)
    .replace(/<!--[\s\S]*?-->/g, keepNewlines)
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('K5：渲染层不出现上游品牌', () => {
  it('src/renderer 里去掉注释后没有 Codex / ChatGPT', () => {
    const hits = sourceFiles(RENDERER).flatMap((file) =>
      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, index) =>
          FORBIDDEN.test(line) ? [`${relative(RENDERER, file)}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });

  it('扫描本身有效：同样的去注释规则能抓到写在 JSX 里的品牌字', () => {
    // 反向核对：一条永远为空的扫描和"没有违规"长得一模一样
    const sample = [
      '// 注释里提到 Codex 不算',
      '<p>这会删除 Codex 已提取的记忆</p>',
      "const url = 'https://example.com/codex';",
    ].join('\n');
    const lines = withoutComments(sample)
      .split('\n')
      .filter((line) => FORBIDDEN.test(line));
    expect(lines).toHaveLength(2);
  });
});
