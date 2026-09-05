/**
 * hook 决策与输出契约（K3 的第三个扩展点）。
 *
 * 三条契约约束（contract.ts 的实测表）的共同点是**失败方式都是"什么都没发生"**：
 * 内核把无效输出丢掉，策略静默失效，而没有任何报错。所以它们在这里被逐条钉住。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  allow,
  deny,
  extractCommand,
  extractPaths,
  handlePermissionRequest,
  handlePostToolUse,
  handlePreToolUse,
  handleSessionEnd,
  permissionDecision,
  serialize,
  type PreToolUseInput,
} from '../src/index.js';

const ENV = { home: '/Users/li', now: () => 1_700_000_000_000 };

function preToolUse(toolInput: Record<string, unknown>, over: Partial<PreToolUseInput> = {}) {
  return handlePreToolUse(
    {
      session_id: 't1',
      turn_id: 'turn1',
      cwd: '/Users/li/work/weekly',
      hook_event_name: 'PreToolUse',
      tool_name: 'shell',
      tool_use_id: 'call1',
      tool_input: toolInput,
      ...over,
    },
    ENV,
  );
}

describe('输出契约（写错了不报错，只是策略静默失效）', () => {
  it('**deny 必须带非空理由** —— 空理由会让整条输出被内核判无效', () => {
    expect(() => deny('PreToolUse', '')).toThrow(/非空理由/);
    expect(() => deny('PreToolUse', '   ')).toThrow();
  });

  it('deny 的形状与内核解析器一致', () => {
    expect(deny('PreToolUse', '这是受保护的位置')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '这是受保护的位置',
      },
    });
  });

  it('**PermissionRequest 用 decision，不是 permissionDecision**（两个事件形状不同）', () => {
    const output = permissionDecision('deny', 'x') as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(output.hookSpecificOutput.decision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('不表态时输出空串（内核按默认流程走）', () => {
    expect(serialize(null)).toBe('');
  });

  it('allow 可以带 updatedInput（只有 allow 时内核才认）', () => {
    const output = allow('PreToolUse', { updatedInput: { command: 'echo ok' } }) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(output.hookSpecificOutput.updatedInput).toEqual({ command: 'echo ok' });
  });

  it('契约文档里没有 "ask" —— 内核不支持它', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/hooks/contract.ts'),
      'utf8',
    );
    expect(source).toContain('不被支持');
    // 代码里不该真的产出 ask
    expect(source).not.toMatch(/permissionDecision:\s*'ask'/);
  });
});

describe('入参里的路径要**宁可多认**', () => {
  it('认得出各种字段名与嵌套', () => {
    const paths = extractPaths({
      file_path: '/a/b.txt',
      options: { cwd: '~/work' },
      targets: ['/c/d.txt', 'not-a-path'],
    });
    expect(paths).toContain('/a/b.txt');
    expect(paths).toContain('~/work');
    expect(paths).toContain('/c/d.txt');
    expect(paths).not.toContain('not-a-path');
  });

  it('Windows 路径也认', () => {
    expect(extractPaths({ p: 'C:\\Users\\x\\a.txt' })).toHaveLength(1);
  });

  it('命令可以是字符串或数组', () => {
    expect(extractCommand({ command: 'ls -la' })).toBe('ls -la');
    expect(extractCommand({ command: ['ls', '-la'] })).toBe('ls -la');
    expect(extractCommand({})).toBeUndefined();
  });
});

describe('PreToolUse：硬拦截**不看 permission_mode**', () => {
  it('访问 ~/.ssh 被拒，理由说清对完全访问也生效', () => {
    const result = preToolUse({ file_path: '/Users/li/.ssh/id_rsa' });
    const output = result.output as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('完全访问');
  });

  it('**permission_mode 是 full-access 时同样拒绝**', () => {
    const result = preToolUse(
      { file_path: '/Users/li/.ssh/id_rsa' },
      { permission_mode: 'danger-full-access' },
    );
    expect(
      (result.output as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput
        .permissionDecision,
    ).toBe('deny');
  });

  it('拦截写审计，且**路径以摘要进去，不是路径本身**', () => {
    const result = preToolUse({ file_path: '/Users/li/.ssh/id_rsa' });
    const record = result.audit[0];
    expect(record?.action).toBe('path.blocked');
    expect(record?.pathKind).toBe('credentials');
    expect(record?.pathDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(record)).not.toContain('.ssh');
  });

  it('工作空间内的路径放行', () => {
    const result = preToolUse({ file_path: '/Users/li/work/weekly/report.docx' });
    expect(result.output).toBeNull();
  });

  it('有风险的命令**放行但带上理由** —— 内核不支持 ask，策略只能这样给审批卡供料', () => {
    const result = preToolUse({ command: 'pip install openpyxl' });
    const output = result.output as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(output.hookSpecificOutput.additionalContext).toContain('为什么需要确认');
    expect(output.hookSpecificOutput.additionalContext).toContain('影响范围');
  });

  it('命令进审计时被截断（审计要的是类型，不是完整复现）', () => {
    const result = preToolUse({ command: `echo ${'x'.repeat(200)}` });
    const summary = result.audit.find((r) => r.action === 'tool.pre')?.actionSummary ?? '';
    // 恰好 80：省略号也算在上限里（调用方按 80 算列宽）
    expect(summary.length).toBe(80);
    expect(summary.endsWith('...')).toBe(true);
  });
});

describe('PermissionRequest：指向受保护位置的提权**直接拒绝**', () => {
  it('不给用户点"允许"的机会 —— 这条路径的存在本身就说明有东西在绕硬拦截', () => {
    const result = handlePermissionRequest(
      {
        session_id: 't1',
        turn_id: 'turn1',
        cwd: '/Users/li/work/weekly',
        tool_input: { path: '~/.aws/credentials' },
      },
      ENV,
    );
    const output = result.output as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput.decision).toBe('deny');
    expect(result.audit[0]?.approvalResult).toBe('decline');
  });

  it('普通提权交给用户，策略层不替用户点允许', () => {
    const result = handlePermissionRequest(
      {
        session_id: 't1',
        turn_id: 'turn1',
        cwd: '/Users/li/work/weekly',
        tool_input: { path: '~/Downloads/invoices/' },
      },
      ENV,
    );
    expect(result.output).toBeNull();
    expect(result.audit[0]?.action).toBe('permission.request');
  });
});

describe('PostToolUse / SessionEnd：审计**只记退出码，不记输出**', () => {
  it('命令输出不进审计（它是正文，与 Q14 同口径）', () => {
    const result = handlePostToolUse(
      {
        session_id: 't1',
        turn_id: 'turn1',
        cwd: '/w',
        hook_event_name: 'PostToolUse',
        tool_name: 'shell',
        tool_use_id: 'call1',
        tool_input: { command: 'cat secret.txt' },
        tool_response: { exit_code: 0, stdout: '这是文件里的机密内容' },
      },
      ENV,
    );
    expect(result.audit[0]?.exitCode).toBe(0);
    expect(JSON.stringify(result.audit)).not.toContain('机密内容');
  });

  it('会话结束记一条', () => {
    const result = handleSessionEnd({ session_id: 't1', reason: 'user-quit' }, ENV);
    expect(result.audit[0]?.action).toBe('session.end');
  });
});

describe('hook 包的接线', () => {
  const PLUGIN_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../plugins/hooks/evowork-policy',
  );

  it('hooks.json 声明的四个事件都有对应脚本', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks.json'), 'utf8')) as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    const events = Object.keys(manifest).filter((k) => !k.startsWith('_'));
    expect(events.sort()).toEqual(['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd']);

    for (const event of events) {
      for (const group of manifest[event] ?? []) {
        for (const hook of group.hooks) {
          const file = hook.command.replace(/^node \$\{CLAUDE_PLUGIN_ROOT\}\//, '');
          expect(() => readFileSync(join(PLUGIN_ROOT, file), 'utf8'), file).not.toThrow();
        }
      }
    }
  });

  it('**脚本里没有决策逻辑** —— 决策全在 handlers.ts（否则测不了）', () => {
    for (const file of [
      'pre-tool-use.mjs',
      'permission-request.mjs',
      'post-tool-use.mjs',
      'session-end.mjs',
    ]) {
      const source = readFileSync(join(PLUGIN_ROOT, 'bin', file), 'utf8');
      expect(
        source
          .split('\n')
          .filter((l) => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('/')).length,
        file,
      ).toBeLessThan(6);
    }
  });

  it('运行器在找不到策略实现时**放行并报错**，不拦住工具', () => {
    const runner = readFileSync(join(PLUGIN_ROOT, 'bin/_runner.mjs'), 'utf8');
    expect(runner).toContain('本次放行');
    // 真正的兜底在沙箱层，不在这个 hook 上 —— 这个判断写在注释里，也钉在这里
    expect(runner).toContain('真正的兜底在沙箱层');
  });
});
