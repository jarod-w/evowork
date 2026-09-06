/**
 * 任务标题的就地派生。
 *
 * 这些断言守的不是"字符串截得对不对"，而是**为什么由我们来起名**：
 * 内核从不自动命名（见 `src/title.ts` 头注释），所以没有这一层，
 * 侧边栏里的每一行都会是「未命名任务」——2026-09-06 的截图就是这个样子。
 */
import { describe, expect, it } from 'vitest';

import { deriveTaskTitle, titleFromText, TITLE_MAX_CHARS } from '../src/title.js';

describe('从第一条需求派生任务标题', () => {
  it('短需求原样成为标题', () => {
    expect(deriveTaskTitle([{ type: 'text', text: '生成一份季度汇报 pptx' }])).toBe(
      '生成一份季度汇报 pptx',
    );
  });

  it('多行需求只取第一个非空行 —— 折成一行会得到一条横贯侧边栏的长句', () => {
    const title = deriveTaskTitle([
      { type: 'text', text: '\n\n把 data/ 下的三张表合并\n然后按季度分组\n再画一张折线图' },
    ]);
    expect(title).toBe('把 data/ 下的三张表合并');
  });

  it('行内的连续空白折叠成一个空格（260 宽的行里空洞比省略号更难认）', () => {
    expect(titleFromText('周报   \t  生成')).toBe('周报 生成');
  });

  it('超长需求截断并加省略号，而不是把整段塞进 rollout 元数据', () => {
    const long = '把'.repeat(TITLE_MAX_CHARS + 20);
    const title = titleFromText(long);
    expect(title).toBe(`${'把'.repeat(TITLE_MAX_CHARS)}…`);
    expect(Array.from(title as string)).toHaveLength(TITLE_MAX_CHARS + 1);
  });

  /*
   * 按码点截而不是按 `String.length` 截。
   *
   * emoji 与部分生僻字是 UTF-16 代理对，`slice` 会把它劈成两半，
   * 表现是标题末尾一个「�」—— 而这不会有任何一层报错。
   */
  it('截断落在 emoji 中间时不会切出半个代理对', () => {
    const title = titleFromText('🎉'.repeat(TITLE_MAX_CHARS + 5));
    expect(title).toBe(`${'🎉'.repeat(TITLE_MAX_CHARS)}…`);
    expect(title).not.toContain('�');
    // 单独确认没有落单的代理码元
    for (const ch of Array.from(title as string)) expect(ch.codePointAt(0)).toBeDefined();
  });

  /*
   * **没有文本就不起名。**
   *
   * 「skill:charts」或「image」不比「未命名任务」更有信息量，而编一个
   * 「新任务 3」是在用一个假名字掩盖"这次没法起名"这件事
   * （CLAUDE.md §9.1：认不出来要如实说）。
   */
  it('只有附件与技能时返回 undefined —— 不编一个假名字', () => {
    expect(
      deriveTaskTitle([
        { type: 'localImage', path: '/tmp/a.png' },
        { type: 'skill', name: 'charts', path: '/skills/charts' },
      ]),
    ).toBeUndefined();
  });

  it('全空白的文本同样不起名（内核也会拒绝空名字）', () => {
    expect(deriveTaskTitle([{ type: 'text', text: '   \n\t \n ' }])).toBeUndefined();
  });
});
