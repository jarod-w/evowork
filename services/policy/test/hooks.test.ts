/**
 * hook 决策与输出契约（K3 的第三个扩展点）。
 *
 * 三条契约约束（contract.ts 的实测表）的共同点是**失败方式都是"什么都没发生"**：
 * 内核把无效输出丢掉，策略静默失效，而没有任何报错。所以它们在这里被逐条钉住。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  parseApplyPatch,
  serialize,
  type HookEnvironment,
  type PreToolUseInput,
} from '../src/index.js';

const ENV: HookEnvironment = {
  home: '/Users/li',
  now: () => 1_700_000_000_000,
  readFile: () => undefined,
};

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

  it('allow 只用来改写工具输入：签名上 updatedInput 就是必填的（不带它的 allow 是无效输出）', () => {
    const output = allow('PreToolUse', { command: 'echo ok' }) as {
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

describe('shell 命令按词判路径（hook 第一次真正接进内核时补的，2026-09-28）', () => {
  it('`cat ~/.ssh/id_rsa` 被拦 —— 以前整行不以 / 开头，凭据清单从没看过 shell', () => {
    const result = preToolUse({ command: 'cat ~/.ssh/id_rsa' });
    const output = result.output as { hookSpecificOutput: Record<string, string> };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.audit[0]?.pathKind).toBe('credentials');
  });

  it('`$HOME/.aws/credentials` 与带引号的写法同样被拦', () => {
    for (const command of [
      'cp $HOME/.aws/credentials out.txt',
      'cat "${HOME}/.ssh/config"',
      "python3 read.py '~/.ssh/id_ed25519'",
    ]) {
      expect(preToolUse({ command }).output, command).not.toBeNull();
    }
  });

  it('执行系统目录里的程序**不是**越界：`/usr/bin/env python3` 以前会被整条当系统目录拒掉', () => {
    for (const command of [
      '/usr/bin/env python3 build.py',
      '/bin/rm inputs/old.md',
      '/bin/zsh -lc "ls"',
      'cat /etc/hosts',
    ]) {
      expect(preToolUse({ command }).output, command).toBeNull();
    }
  });

  it('`command` 以外的路径字段仍按整条判，system-dirs 照拦', () => {
    const output = preToolUse({ file_path: '/etc/sudoers' }).output as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
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

  it('有风险的命令**不表态**：`allow` 不带 updatedInput 是无效输出，内核会丢掉整条', () => {
    const result = preToolUse({ command: 'pip install openpyxl' });
    // 拦不拦交给内核的审批流；卡片上的理由由主进程给（commandApprovalRationale）
    expect(result.output).toBeNull();
    expect(result.audit.some((r) => r.action === 'tool.pre')).toBe(true);
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

describe('apply_patch 的删除与整篇覆盖：拒绝并指路到会弹审批的写法（D1-2 真模型复测，2026-10-01）', () => {
  const CWD = '/Users/li/work/weekly';
  // 失败轮次里真模型的原样调用：exec_command 里的 heredoc，内核截下来按补丁应用、工作空间内不问
  const viaShell = (body: string) =>
    `apply_patch <<'PATCH'\n*** Begin Patch\n${body}\n*** End Patch\nPATCH`;
  const files: Record<string, string> = {
    [`${CWD}/inputs/D1_notes.md`]: '# 会议纪要\n\n- 三季度存款目标达成 92%\n',
  };
  const env: HookEnvironment = { ...ENV, readFile: (path) => files[path] };
  const run = (command: string, toolName = 'Bash') =>
    handlePreToolUse(
      {
        session_id: 't1',
        turn_id: 'turn1',
        cwd: CWD,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_use_id: 'call1',
        tool_input: { command },
      },
      env,
    );
  const reasonOf = (result: ReturnType<typeof run>) =>
    String(result.output?.hookSpecificOutput.permissionDecisionReason ?? '');

  it('删除：拒绝并让它改用 rm（rm 会弹审批）—— 那一轮就是「printf 被拒后删了重建」', () => {
    const result = run(viaShell('*** Delete File: inputs/D1_notes.md'));
    expect(result.output?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(result)).toContain('rm');
    expect(result.audit[0]).toMatchObject({
      action: 'permission.decided',
      approvalResult: 'decline',
      actionSummary: 'APPLY_PATCH_DELETE',
    });
    // 审计里只有路径摘要（Q14）
    expect(JSON.stringify(result.audit)).not.toContain('D1_notes');
  });

  it('把已有文件一行不留地换掉 = 覆盖：拒绝并让它改用 shell 重定向（P6 会弹审批）', () => {
    const result = run(
      viaShell(
        '*** Update File: inputs/D1_notes.md\n@@\n-# 会议纪要\n-\n-- 三季度存款目标达成 92%\n+已归档',
      ),
    );
    expect(result.output?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(result)).toContain('> inputs/D1_notes.md');
    expect(result.audit[0]?.actionSummary).toBe('APPLY_PATCH_OVERWRITE');
  });

  it('Add File 写到已有文件上同样是覆盖 —— 内核的 AddFile 不查文件在不在，拦了删除它就是下一条路', () => {
    const result = run(viaShell('*** Add File: inputs/D1_notes.md\n+已归档'));
    expect(result.output?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('原生 apply_patch 工具（tool_name = apply_patch，入参就是补丁本身）也一样', () => {
    const result = run(
      '*** Begin Patch\n*** Delete File: inputs/D1_notes.md\n*** End Patch',
      'apply_patch',
    );
    expect(result.output?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('**局部修改照常不问**（「请求批准」的定义是工作空间内编辑不问）', () => {
    const result = run(
      viaShell(
        '*** Update File: inputs/D1_notes.md\n@@\n # 会议纪要\n \n-- 三季度存款目标达成 92%\n+- 三季度存款目标达成 93%',
      ),
    );
    expect(result.output).toBeNull();
  });

  it('**新建文件照常不问** —— 模型最常见的动作', () => {
    expect(run(viaShell('*** Add File: outputs/周报.md\n+# 周报')).output).toBeNull();
  });

  it('只是把补丁文本打印出来、没调 apply_patch 的命令不算', () => {
    expect(
      parseApplyPatch(
        'Bash',
        "cat <<'EOF'\n*** Begin Patch\n*** Delete File: a.md\n*** End Patch\nEOF",
      ),
    ).toBeUndefined();
  });
});

describe('hook 包的接线', () => {
  const PLUGIN_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../plugins/hooks/evowork-policy',
  );

  it('hooks.json 声明的四个事件都有对应脚本', () => {
    const file = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks.json'), 'utf8')) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    // 内核的 HooksFile：事件在 `hooks` 里。放在顶层 = 解析成空集、被静默丢掉
    const manifest = file.hooks ?? {};
    const events = Object.keys(manifest);
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

  it('**运行器真实给出的环境**能让覆盖判定生效 —— 运行器是 .mjs，不在类型检查里，漏给 readFile 不会报错', async () => {
    const runnerPath = join(PLUGIN_ROOT, 'bin/_runner.mjs');
    const runner = (await import(runnerPath)) as { hookEnvironment: () => HookEnvironment };
    const workspace = mkdtempSync(join(tmpdir(), 'hook-runner-'));
    try {
      writeFileSync(join(workspace, 'notes.md'), '# 会议纪要\n');
      const result = handlePreToolUse(
        {
          session_id: 't1',
          turn_id: 'turn1',
          cwd: workspace,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_use_id: 'call1',
          tool_input: {
            command:
              "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: notes.md\n+已归档\n*** End Patch\nPATCH",
          },
        },
        runner.hookEnvironment(),
      );
      expect(result.output?.hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('运行器在找不到策略实现时**放行并报错**，不拦住工具', () => {
    const runner = readFileSync(join(PLUGIN_ROOT, 'bin/_runner.mjs'), 'utf8');
    expect(runner).toContain('本次放行');
    // 真正的兜底在沙箱层，不在这个 hook 上 —— 这个判断写在注释里，也钉在这里
    expect(runner).toContain('真正的兜底在沙箱层');
  });
});
