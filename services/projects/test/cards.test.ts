/**
 * 卡片上三个数字的口径（spec §2.1）。
 *
 * "差不多"的计数会让用户不信任整页，所以每条口径都在这里钉住。
 */
import { describe, expect, it } from 'vitest';

import { buildProjectCard, ellipsizeMiddle } from '../src/index.js';
import type { ArtifactLite, ProjectRecord, ThreadLite } from '../src/index.js';

const HOME = '/Users/li';

// 与 cards.ts 里 ROOT_DISPLAY_MAX 的默认值保持一致（该常量未导出，属性测试
// 只关心"不超过输入长度"这条后置条件，不关心具体数值，所以本地复制一份即可）。
const DEFAULT_MAX = 36;

const PROJECT: ProjectRecord = {
  id: 'p1',
  name: '季度汇报',
  roots: ['/w/q3'],
  createdAt: 1,
  updatedAt: 1,
};

function build(threads: readonly ThreadLite[], artifacts: readonly ArtifactLite[], exists = true) {
  return buildProjectCard({
    project: PROJECT,
    threads,
    artifacts,
    rootExists: () => exists,
    home: HOME,
  });
}

describe('buildProjectCard', () => {
  it('任务数不含已归档的 —— 归档是用户主动收起来的，还算进去就是在跟他争', () => {
    const card = build(
      [
        { cwd: '/w/q3/a', archived: false, recencyAt: 100 },
        { cwd: '/w/q3/b', archived: true, recencyAt: 200 },
      ],
      [],
    );
    expect(card.taskCount).toBe(1);
  });

  it('cwd 为 null 的任务不属于任何空间', () => {
    const card = build([{ cwd: null, archived: false, recencyAt: 100 }], []);
    expect(card.taskCount).toBe(0);
  });

  it('root 外的任务不算进来', () => {
    const card = build([{ cwd: '/elsewhere', archived: false, recencyAt: 100 }], []);
    expect(card.taskCount).toBe(0);
  });

  it('产物按 path 去重 —— 否则同一个文件改三版会显示"3 个产物"', () => {
    const card = build(
      [],
      [
        { path: '/w/q3/r.docx', version: 1, fileState: 'PRESENT' },
        { path: '/w/q3/r.docx', version: 2, fileState: 'PRESENT' },
        { path: '/w/q3/r.docx', version: 3, fileState: 'PRESENT' },
      ],
    );
    expect(card.artifactCount).toBe(1);
  });

  it('只数 PRESENT 的产物 —— 文件已经不在了还报数，用户点开是空的', () => {
    const card = build(
      [],
      [
        { path: '/w/q3/a.docx', version: 1, fileState: 'PRESENT' },
        { path: '/w/q3/b.docx', version: 1, fileState: 'MISSING' },
        { path: '/w/q3/c.docx', version: 1, fileState: 'MOVED' },
      ],
    );
    expect(card.artifactCount).toBe(1);
  });

  it('建了又删的文件不能算数 —— 先按 version 折叠再看 PRESENT，不能先滤 PRESENT 再去重', () => {
    // v1 PRESENT + v2 MISSING/MOVED：文件已经不在了，即使 v1 那行仍标 PRESENT
    // 也不能把它算进产物数，否则用户点开是空的。
    const deleted = build(
      [],
      [
        { path: '/w/q3/r.docx', version: 1, fileState: 'PRESENT' },
        { path: '/w/q3/r.docx', version: 2, fileState: 'MISSING' },
      ],
    );
    expect(deleted.artifactCount).toBe(0);

    const movedAway = build(
      [],
      [
        { path: '/w/q3/r.docx', version: 1, fileState: 'PRESENT' },
        { path: '/w/q3/r.docx', version: 2, fileState: 'MOVED' },
      ],
    );
    expect(movedAway.artifactCount).toBe(0);

    // v1 MISSING + v2 PRESENT：文件被重新创建，这次要算上。
    const recreated = build(
      [],
      [
        { path: '/w/q3/r.docx', version: 1, fileState: 'MISSING' },
        { path: '/w/q3/r.docx', version: 2, fileState: 'PRESENT' },
      ],
    );
    expect(recreated.artifactCount).toBe(1);
  });

  it('最近活动取空间内任务的最大 recencyAt', () => {
    const card = build(
      [
        { cwd: '/w/q3/a', archived: false, recencyAt: 100 },
        { cwd: '/w/q3/b', archived: false, recencyAt: 900 },
      ],
      [],
    );
    expect(card.recencyAt).toBe(900);
  });

  it('一个任务都没有时 recencyAt 是 null —— 页面据此不显示这一段，而不是显示"从未"', () => {
    expect(build([], []).recencyAt).toBeNull();
  });

  it('root 不存在时标 missing —— 不静默改路径也不自动移除', () => {
    const card = build([], [], false);
    expect(card.rootState).toBe('missing');
    // 失效了也仍然是那个路径：改掉它用户就找不回自己的目录了
    expect(card.rootPath).toBe('/w/q3');
  });

  it('没有 root 的空间不崩，rootPath 为空串且状态是 missing', () => {
    const card = buildProjectCard({
      project: { ...PROJECT, roots: [] },
      threads: [],
      artifacts: [],
      rootExists: () => true,
      home: HOME,
    });
    expect(card.rootPath).toBe('');
    expect(card.rootState).toBe('missing');
  });
});

describe('ellipsizeMiddle', () => {
  it('短路径原样返回', () => {
    expect(ellipsizeMiddle('~/w/q3', 40)).toBe('~/w/q3');
  });

  it('省略中间段，头尾都留着 —— 尾巴是用户认出目录的依据', () => {
    const out = ellipsizeMiddle('~/a/b/c/d/e/f/g/quarterly-report', 20);
    expect(out.startsWith('~/a')).toBe(true);
    expect(out.endsWith('quarterly-report')).toBe(true);
    expect(out).toContain('…');
  });

  it('尾段本身就超长时不再截尾 —— 截掉文件夹名就等于没有信息', () => {
    const out = ellipsizeMiddle('/x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10);
    expect(out).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('单段绝对路径不能拼出比输入还长的结果，目录名也不能被印两遍', () => {
    // lastIndexOf('/') === 0：整条路径只有开头那一个分隔符，没有"中段"可省。
    // 旧实现会把 tail 算成整个输入，再在前面拼一个 head —— 结果比输入还长，
    // 目录名相当于出现了两次。
    const root = '/' + 'a'.repeat(40); // 41 字符
    const out = ellipsizeMiddle(root); // max = 36（默认）
    expect(out.length).toBeLessThanOrEqual(root.length);
    expect(out).not.toBe(root);
  });

  // 属性测试：不论输入是什么形状，输出长度绝不能超过输入长度。
  // 这是 ellipsizeMiddle 的后置条件，用一张覆盖各种"斜杠形状"的表来穷举，
  // 而不是零散地各写一个例子。
  const SHAPES: ReadonlyArray<{
    readonly label: string;
    readonly path: string;
    readonly max?: number;
  }> = [
    { label: '空字符串', path: '' },
    { label: '完全没有斜杠', path: 'a'.repeat(50) },
    { label: '单个前导斜杠 + 超长段', path: '/' + 'a'.repeat(50) },
    { label: '两段', path: '/w/' + 'quarterly-report-final-v2'.repeat(3) },
    { label: '很多段', path: '/a/b/c/d/e/f/g/h/i/j/' + 'k'.repeat(30) },
    { label: '长度恰好等于 max', path: 'x'.repeat(DEFAULT_MAX) },
    { label: '长度恰好比 max 多 1', path: 'x'.repeat(DEFAULT_MAX + 1) },
    { label: '主目录风格的深路径', path: '~/dev/a/b/c/d/quarterly-report-with-a-long-name.docx' },
  ];

  it.each(SHAPES)(
    '$label —— 输出长度绝不超过输入长度（否则卡片上的路径比真实路径还长）',
    ({ path, max }) => {
      const out = max === undefined ? ellipsizeMiddle(path) : ellipsizeMiddle(path, max);
      expect(out.length).toBeLessThanOrEqual(path.length);
    },
  );
});
