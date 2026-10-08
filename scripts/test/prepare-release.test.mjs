import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { newerVersion, notesFromSubjects, prepareRelease } from '../prepare-release.mjs';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'evowork-release-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Release Test');
  mkdirSync(join(root, 'apps/desktop'), { recursive: true });
  mkdirSync(join(root, 'build'));
  for (const path of ['package.json', 'apps/desktop/package.json'])
    writeFileSync(join(root, path), '{"version":"0.0.5"}\n');
  writeFileSync(join(root, 'build/release-notes.md'), '- 上一版说明\n');
  git('add', '.');
  git('commit', '-m', 'feat: previous release');
  git('tag', 'v0.0.5');
  writeFileSync(join(root, 'feature.txt'), 'feature');
  git('add', '.');
  git('commit', '-m', 'feat(search): 支持正文搜索');
  return { root, git };
}

describe('准备发布', () => {
  it('按数字比较正式版本，拒绝降级和非法版本', () => {
    expect(newerVersion('0.0.10', '0.0.9')).toBe(true);
    for (const version of ['0.0.5', '0.0.4', '01.0.6', '0.0.6-beta'])
      expect(newerVersion(version, '0.0.5')).toBe(false);
  });

  it('过滤内部提交、去重，同时保留不兼容变更和普通标题', () => {
    expect(
      notesFromSubjects([
        'docs: internal',
        'chore: internal',
        'refactor!: 接口改变',
        'feat(search): 搜索文档',
        'fix: 搜索文档',
        '修复窗口',
        'Merge branch main',
      ]),
    ).toBe('- 不兼容变更：接口改变\n- 搜索文档\n- 修复窗口\n');
  });

  it('预览不写入；实际执行同步版本与说明，并保留上一版记录', () => {
    const { root, git } = repository();
    prepareRelease(root, ['0.0.6', '--dry-run']);
    expect(git('status', '--porcelain').trim()).toBe('');
    prepareRelease(root, ['0.0.6']);
    for (const path of ['package.json', 'apps/desktop/package.json'])
      expect(JSON.parse(readFileSync(join(root, path), 'utf8')).version).toBe('0.0.6');
    expect(readFileSync(join(root, 'build/release-notes.md'), 'utf8')).toBe('- 支持正文搜索\n');
    const history = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(history).toContain('## 0.0.6');
    expect(history).toContain('## 0.0.5\n\n- 上一版说明');
    expect(git('tag', '--list').trim()).toBe('v0.0.5');
  });

  it('工作区不干净或没有发布基线时拒绝写入', () => {
    const { root, git } = repository();
    writeFileSync(join(root, 'dirty.txt'), 'unfinished');
    expect(() => prepareRelease(root, ['0.0.6'])).toThrow('工作区');
    git('add', '.');
    git('commit', '-m', 'test: internal');
    git('tag', '-d', 'v0.0.5');
    expect(() => prepareRelease(root, ['0.0.6'])).toThrow('没有可达');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('0.0.5');
  });
});
