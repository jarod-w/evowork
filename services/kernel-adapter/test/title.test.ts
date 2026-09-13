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

/*
 * 客套占的是**标题预算**，不是排版。
 *
 * 24 字里被「麻烦帮我」吃掉 4 个，代价是真正的主语被挤到省略号后面 ——
 * 这正是 Claude Code 那条提示词要砍请求动词的理由，这里用规则做掉能做的那半。
 */
describe('剥掉客套', () => {
  it('去掉礼貌前缀', () => {
    expect(titleFromText('帮我把 data/ 下的三张表合并')).toBe('把 data/ 下的三张表合并');
    expect(titleFromText('请问能不能做一个季度汇报的 PPT')).toBe('做一个季度汇报的 PPT');
  });

  it('叠起来的客套一起剥（「麻烦帮我」是两层）', () => {
    expect(titleFromText('麻烦帮我看看迁移器有没有问题')).toBe('看看迁移器有没有问题');
  });

  it('去掉句末标点', () => {
    expect(titleFromText('标题是如何产生的?')).toBe('标题是如何产生的');
  });

  /*
   * **只砍框架，不砍内容动词。**
   *
   * 模型能砍 generate / fix 是因为它知道剩下的是什么；规则不知道。
   * 这两条断言守的就是那条边界 —— 谁想"再智能一点"，会先撞到它们。
   */
  it('内容动词留着 —— 砍错一个动词是把标题变成谎话', () => {
    expect(titleFromText('生成一份季度汇报 pptx')).toBe('生成一份季度汇报 pptx');
    expect(titleFromText('删除上季度的归档')).toBe('删除上季度的归档');
  });

  it('「请求」不是客套 —— 否则「请求参数怎么传」会变成「求参数怎么传」', () => {
    expect(titleFromText('请求参数怎么传')).toBe('请求参数怎么传');
    expect(titleFromText('请假流程是什么')).toBe('请假流程是什么');
  });

  it('整句都是客套时不起名，而不是留下一个空标题', () => {
    expect(titleFromText('帮我')).toBeUndefined();
    expect(titleFromText('请问？')).toBeUndefined();
  });

  /* 剥在截断**之前**：否则「麻烦帮我」占掉的 4 个字再也拿不回来 */
  it('先剥后截 —— 省下来的字数用在正文上', () => {
    const body = '把'.repeat(TITLE_MAX_CHARS);
    expect(titleFromText(`帮我${body}`)).toBe(body);
  });

  /* 截断加的省略号不能被句末标点规则吃掉（两者顺序反了就会） */
  it('截断产生的省略号留着', () => {
    expect(titleFromText('把'.repeat(TITLE_MAX_CHARS + 5))).toMatch(/…$/);
  });
});
