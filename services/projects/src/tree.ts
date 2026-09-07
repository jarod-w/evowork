/**
 * 中栏文件树的纯逻辑（spec §3.3）。
 *
 * D-P5：懒加载、不接 `fs/watch`。展开哪层读哪层，所以这里只处理**一层**的
 * 排序与标注，以及"这层能不能读"的判定。
 */
import { isUnderRoot, toAbsolute } from './membership.js';

/**
 * 默认折叠的噪声目录。
 *
 * **折叠不是隐藏**：它们仍然出现在列表里，只是默认不展开、样式弱化。
 * 隐藏掉的话，用户在树里找不到 `dist/report.docx` 会以为文件丢了 ——
 * 而那正是他刚让 agent 生成的东西。
 */
export const NOISE_DIRS: readonly string[] = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.venv',
  '__pycache__',
  '.next',
  'target',
  '.cache',
]);

export interface DirEntryInput {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface TreeEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** 默认折叠 + 样式弱化，**不是隐藏** */
  readonly noisy: boolean;
}

/** 目录在前、各自按名（`localeCompare`，中文目录名按拼音而不是码点） */
export function sortEntries(entries: readonly DirEntryInput[]): readonly TreeEntry[] {
  return [...entries]
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      // 噪声判定只针对目录：叫 `dist` 的文件是用户自己的东西
      noisy: entry.isDirectory && NOISE_DIRS.includes(entry.name),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans');
    });
}

/**
 * 渲染层要展开的路径能不能读。**返回 null = 拒绝**。
 *
 * 这是主进程唯一该信的判定：渲染层传过来的字符串不可信，
 * `<root>/../.ssh` 看起来完全正常，归一化之后才露出来。
 *
 * 判定与折回真实路径都复用 `membership.ts` 的 `toAbsolute`——它已经踩过两次
 * `~` 折叠的坑（home 恰好是 `/` 时全局折叠、`trimTrailing` 只去一个斜杠），
 * 这里再写一份自己的展开逻辑就是制造第三份、迟早分叉的版本。
 */
export function resolveChildPath(root: string, requested: string, home: string): string | null {
  if (!isUnderRoot(root, requested, home)) return null;
  // 到这里说明 requested 已经在 root 之内；去掉结尾斜杠只是让返回值形态统一，
  // 不影响安全判定——判定已经在 isUnderRoot 里做完了。
  return toAbsolute(requested, home).replace(/\/+$/, '') || '/';
}
