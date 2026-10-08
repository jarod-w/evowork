#!/usr/bin/env node
/** 本地准备版本与更新说明；不提交、不打 tag、不发布。 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function newerVersion(next, current) {
  if (!VERSION.test(next) || !VERSION.test(current)) return false;
  const a = next.split('.').map(BigInt);
  const b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** 只做确定性的整理，不把提交标题伪装成已经审核的用户文案。 */
export function notesFromSubjects(subjects) {
  const notes = [];
  for (const subject of subjects) {
    const match = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/.exec(subject);
    if (match && !match[2] && /^(docs?|test|chore|ci|build|refactor|style)$/.test(match[1]))
      continue;
    if (/^Merge\b/.test(subject)) continue;
    const note = match ? `${match[2] ? '不兼容变更：' : ''}${match[3]}` : subject.trim();
    if (note && !notes.includes(note)) notes.push(note);
  }
  return notes.map((note) => `- ${note}`).join('\n') + (notes.length ? '\n' : '');
}

export function prepareRelease(root, argv) {
  const [version, ...flags] = argv;
  if (!VERSION.test(version ?? '') || flags.some((flag) => flag !== '--dry-run'))
    throw new Error('用法：pnpm run release:prepare -- <新版本 x.y.z> [--dry-run]');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const paths = ['package.json', 'apps/desktop/package.json'];
  const packages = paths.map((path) => JSON.parse(readFileSync(join(root, path), 'utf8')));
  const current = packages[0].version;
  if (packages.some((pkg) => pkg.version !== current))
    throw new Error('两个 package.json 的版本不一致');
  if (!newerVersion(version, current))
    throw new Error(`新版本必须高于 ${current}（只支持正式版本 x.y.z）`);
  if (git('status', '--porcelain')) throw new Error('工作区有未提交改动，请先提交或暂存到 stash');
  if (git('tag', '--list', `v${version}`)) throw new Error(`v${version} 已存在`);
  // 只选当前分支可达的正式版本 tag；不按 tag 创建时间判断版本。
  const tags = git('tag', '--merged', 'HEAD', '--sort=-version:refname')
    .split('\n')
    .filter((tag) => tag.startsWith('v') && VERSION.test(tag.slice(1)));
  const base = tags[0];
  if (!base) throw new Error('没有可达的发布 tag（vX.Y.Z），无法确定更新范围');
  if (newerVersion(base.slice(1), current)) throw new Error('最近发布 tag 高于当前源码版本');
  const notes = notesFromSubjects(
    git('log', '--reverse', '--format=%s', `${base}..HEAD`).split('\n'),
  );
  if (!notes) throw new Error(`${base}..HEAD 没有可生成的用户变更，请先提交功能或修复`);
  const historyPath = join(root, 'CHANGELOG.md');
  const history = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '# 更新记录\n\n';
  if (history.includes(`## ${version}\n`)) throw new Error(`CHANGELOG.md 已有 ${version}`);
  const baseline = history.includes(`## ${current}\n`)
    ? ''
    : `## ${current}\n\n${readFileSync(join(root, 'build/release-notes.md'), 'utf8').trim()}\n\n`;
  const entry = `## ${version}\n\n<!-- 草稿：来自 ${base}..HEAD；发布前审核，并同步 build/release-notes.md。 -->\n\n${notes}\n`;
  const nextHistory = '# 更新记录\n\n' + entry + baseline + history.replace(/^# 更新记录\s*/, '');
  console.log(`${current} → ${version}；提交范围：${base}..HEAD\n\n${notes}`);
  if (flags.includes('--dry-run')) {
    console.log('预览完成，未修改文件。');
    return;
  }
  paths.forEach((path, i) => {
    packages[i].version = version;
    writeFileSync(join(root, path), JSON.stringify(packages[i], null, 2) + '\n');
  });
  writeFileSync(join(root, 'build/release-notes.md'), notes);
  writeFileSync(historyPath, nextHistory);
  console.log(
    '已更新两个版本号、build/release-notes.md 和 CHANGELOG.md。请审核草稿、同步两处说明并检查 git diff，再提交、打 tag 和打包发布。',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    prepareRelease(
      ROOT,
      process.argv.slice(2).filter((arg) => arg !== '--'),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
