import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { gitCheckoutHead } from '../git-checkout-head.mjs';
it('打包引用、独立 worktree 与 detached HEAD 都报告真实提交，不误报协议漂移', () => {
  const temp = mkdtempSync(join(tmpdir(), 'evowork-git-head-')),
    repo = join(temp, 'repo'),
    work = join(temp, 'work');
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git('init', '-b', 'main', repo);
    git(
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const expected = git('-C', repo, 'rev-parse', '--short=12', 'HEAD');
    expect(gitCheckoutHead(repo)).toBe(expected);
    git('-C', repo, 'pack-refs', '--all');
    expect(existsSync(join(repo, '.git/refs/heads/main'))).toBe(false);
    expect(gitCheckoutHead(repo)).toBe(expected);
    git('-C', repo, 'worktree', 'add', '--detach', work);
    expect(gitCheckoutHead(work)).toBe(expected);
    git('-C', repo, 'checkout', '--detach');
    expect(gitCheckoutHead(repo)).toBe(expected);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
