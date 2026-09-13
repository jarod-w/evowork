/**
 * 用产物给任务起名。
 *
 * 这些断言守的是**默认答案是"不改名"**：截出来的标题至少是用户自己的字，
 * 把它换成一个更差的名字（`output.docx`、一次 edit 的文件名、v2 的重渲染）
 * 是净损失。四道闸门各对应一种"更差"。
 */
import { describe, expect, it } from 'vitest';

import { taskTitleFromArtifact, type ArtifactRecord } from '../src/index.js';

function record(over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'af1',
    threadId: 't1',
    path: '/w/Q3经营分析.docx',
    artifactType: 'document',
    outputFormat: 'docx',
    title: 'Q3 经营分析',
    operationKind: 'create',
    version: 1,
    sourceSignal: 'SKILL_REPORT',
    fileState: 'PRESENT',
    createdAt: 0,
    ...over,
  };
}

describe('产物给任务起名', () => {
  it('技能上报的显示名成为任务标题', () => {
    expect(taskTitleFromArtifact(record())).toEqual({ threadId: 't1', title: 'Q3 经营分析' });
  });

  /*
   * 信号 ②③ 的 `title` 是 `recognize` 拿 basename 兜的底。
   * 用它改名等于把用户原话换成 `output.docx` —— 比不改更糟。
   */
  it('只认技能上报 —— 文件监听与 hook 扫出来的只有文件名', () => {
    expect(taskTitleFromArtifact(record({ sourceSignal: 'FILE_CHANGE' }))).toBeUndefined();
    expect(taskTitleFromArtifact(record({ sourceSignal: 'HOOK_SCAN' }))).toBeUndefined();
  });

  it('技能没传 --title 时（显示名就是文件名）不改名', () => {
    expect(taskTitleFromArtifact(record({ title: 'Q3经营分析.docx' }))).toBeUndefined();
  });

  it('edit 不改名 —— 被改的文件有自己的名字，那不是这次任务的主题', () => {
    expect(taskTitleFromArtifact(record({ operationKind: 'edit' }))).toBeUndefined();
  });

  it('v2 不改名 —— 同一份产物重渲染一次，主题没变', () => {
    expect(taskTitleFromArtifact(record({ version: 2 }))).toBeUndefined();
  });

  /* 定时任务在没打开任何任务时产出的文件没有归属，改不了谁的名 */
  it('没有 threadId 就没有可改名的对象', () => {
    expect(taskTitleFromArtifact(record({ threadId: undefined }))).toBeUndefined();
  });

  it('超长显示名按码点截断，不切出半个代理对', () => {
    const title = taskTitleFromArtifact(record({ title: '🎉'.repeat(40) }))?.title ?? '';
    expect(title).toMatch(/…$/);
    expect(title).not.toContain('�');
    expect(Array.from(title)).toHaveLength(25);
  });
});
