/**
 * 产品身份底稿：与内核 `default.md` 只差身份段（F25）。
 *
 * 上游改工具调用 / 沙箱 / AGENTS.md 那些段时，这个测试会红 —— 那是提醒我们
 * 把 fork 同步过去，而不是把整份底稿扔掉。身份段的替换写在下面这张表里，
 * 改底稿或改替换都必须两边一起动。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readBaseInstructions } from '../src/main/service-host.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OURS = join(REPO_ROOT, 'config/prompts/base-instructions.md');
const KERNEL = join(
  process.env.EVOWORK_KERNEL_DIR ?? join(REPO_ROOT, '..', 'codex'),
  'codex-rs/protocol/src/prompts/base_instructions/default.md',
);

/** 只改身份，不改工具契约。from 必须在内核稿里逐字存在，否则测试会先红。 */
const IDENTITY_REPLACEMENTS: readonly [string, string][] = [
  [
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.',
    "You are EvoWork's execution agent, a local workplace AI assistant. You are expected to be precise, safe, and helpful.",
  ],
  [
    'Within this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).',
    'Within this context, EvoWork is the product the user is talking to. Do not identify as Codex, Codex CLI, or an OpenAI product unless the user explicitly asks about the underlying runtime.',
  ],
  [
    'You are a coding agent. Please keep going until the query is completely resolved',
    'You are an execution agent. Please keep going until the query is completely resolved',
  ],
  [
    'The CLI is not able to render these so they will just be broken in the UI.',
    'The product UI is not able to render these so they will just be broken.',
  ],
  [
    'You are producing plain text that will later be styled by the CLI.',
    'You are producing plain text that will later be styled by the product UI.',
  ],
  ['the CLI renderer', 'the product UI renderer'],
];

describe('readBaseInstructions', () => {
  it('从随包 config/prompts 读出 EvoWork 身份，不是装进 ~/.evowork 再读', () => {
    const text = readBaseInstructions(join(REPO_ROOT, 'config'));
    expect(text).toContain("You are EvoWork's execution agent");
    expect(text).not.toContain('running in the Codex CLI');
  });

  it('目录或文件不在时返回 undefined —— 宿主据此发出 notice，不静默继续', () => {
    expect(readBaseInstructions(undefined)).toBeUndefined();
    expect(readBaseInstructions(join(REPO_ROOT, 'does-not-exist'))).toBeUndefined();
  });
});

describe('与内核 default.md 的漂移', () => {
  it.skipIf(!existsSync(KERNEL))(
    '我们的 fork 等于内核稿逐条替换身份段；其它段落必须字节一致',
    () => {
      let expected = readFileSync(KERNEL, 'utf8');
      for (const [from, to] of IDENTITY_REPLACEMENTS) {
        expect(expected, `内核稿里找不到要替换的身份段：${from.slice(0, 48)}…`).toContain(from);
        expected = expected.replaceAll(from, to);
      }
      expect(readFileSync(OURS, 'utf8')).toBe(expected);
    },
  );

  it('随包底稿不含 Codex CLI 自称，且含 EvoWork', () => {
    const text = readFileSync(OURS, 'utf8');
    expect(text).toContain('EvoWork');
    expect(text).not.toMatch(/running in the Codex CLI/);
    expect(text).not.toMatch(/Codex CLI is an open source project led by OpenAI/);
  });
});
