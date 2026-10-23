/** Git 自己解析松散/打包引用与 worktree 指针；不靠 .git/refs 的物理布局猜 HEAD。 */
import { execFileSync } from 'node:child_process';
export function gitCheckoutHead(directory) {
  try {
    return execFileSync('git', ['-C', directory, 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '未知';
  }
}
