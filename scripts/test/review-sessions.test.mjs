import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyze,
  commandFlags,
  memoryFindings,
  renderMarkdown,
  summarizeRollout,
} from '../review-sessions.mjs';

/** 照内核会话记录的形状造一个会话（只造脚本读的字段） */
function rollout(id, { ask = '帮我做周报', attachment, calls = [], end = 'complete', usage = [] }) {
  const records = [
    {
      type: 'session_meta',
      payload: { id, timestamp: '2026-10-22T01:00:00Z', cwd: '/Users/li/私密项目' },
    },
    { type: 'event_msg', timestamp: '2026-10-22T01:00:00Z', payload: { type: 'task_started' } },
    {
      type: 'turn_context',
      payload: { model: 'deepseek/deepseek-flash', sandbox_policy: { type: 'workspace-write' } },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'UserMessage',
          content: [
            { type: 'text', text: ask },
            ...(attachment
              ? [
                  {
                    type: 'text',
                    text: `【附件说明 · 由 EvoWork 自动生成，不是用户的原话】\n用户上传了《${attachment}》，…`,
                  },
                ]
              : []),
          ],
        },
      },
    },
  ];
  for (const [
    i,
    { name = 'exec_command', cmd, output = 'Process exited with code 0' },
  ] of calls.entries()) {
    records.push({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name,
        call_id: `c${i}`,
        arguments: JSON.stringify({ cmd }),
      },
    });
    records.push({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: `c${i}`, output },
    });
  }
  for (const input of usage)
    records.push({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: input - 100,
            output_tokens: 10,
          },
        },
      },
    });
  records.push(
    end === 'aborted'
      ? {
          type: 'event_msg',
          payload: { type: 'turn_aborted', reason: 'interrupted', duration_ms: 3000 },
        }
      : end === 'context'
        ? {
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              duration_ms: 5000,
              error: { codex_error_info: 'context_window_exceeded' },
            },
          }
        : {
            type: 'event_msg',
            payload: { type: 'task_complete', duration_ms: 5000, last_agent_message: '完成了' },
          },
  );
  return records;
}

describe('命令里的复盘信号（2026-10-22 手工复盘的那几类）', () => {
  it('读随包技能与内核亲口给的技能 / 记忆路径是正常用法，不算「翻产品」', () => {
    for (const cmd of [
      'cat /Applications/EvoWork.app/Contents/Resources/plugins/skills/documents/SKILL.md',
      'cat ~/.evowork/kernel/skills/open-kimi-ppt/reference/pptd.md',
      'grep -n 周报 /Users/li/.evowork/kernel/memories/MEMORY.md',
      'ls ~/.evowork/skills/x && ~/.evowork/runtime/office/bin/python3 a.py',
    ]) {
      expect(commandFlags(cmd), cmd).not.toContain('inspect-app-bundle');
      expect(commandFlags(cmd), cmd).not.toContain('inspect-app-state');
    }
  });

  it('翻安装包里的代码、翻内核配置与会话，各算一次', () => {
    expect(
      commandFlags('grep -n skillRoots /Applications/EvoWork.app/Contents/Resources/app/main.js'),
    ).toContain('inspect-app-bundle');
    expect(commandFlags('cat ~/.evowork/kernel/config.toml')).toContain('inspect-app-state');
    expect(commandFlags('ls $HOME/.evowork/kernel/sessions/2026')).toContain('inspect-app-state');
  });

  it('全盘搜索；中间目录建在工作区与建在系统临时目录分开计', () => {
    expect(commandFlags('find / -name pptd.md 2>/dev/null')).toContain('disk-wide-search');
    expect(commandFlags('find . -name x')).not.toContain('disk-wide-search');
    expect(commandFlags('mkdir -p /Users/li/AI/.build && cd .build')).toContain(
      'scratch-in-workspace',
    );
    const tmp = commandFlags('mkdir -p "$TMPDIR/evowork-x" && python3 build.py');
    expect(tmp).toContain('scratch-in-tmp');
    expect(tmp).not.toContain('scratch-in-workspace');
  });
});

describe('一个会话的摘要', () => {
  it('拦截理由只留「这是…」那一句，不留路径；产品注入的附件说明不算用户的话', () => {
    const session = summarizeRollout(
      rollout('s1', {
        ask: '安装附件里的 SKILL',
        attachment: 'SKILL.md',
        calls: [
          {
            cmd: 'ls ~/.evowork/kernel/x',
            output:
              'Command blocked by PreToolUse hook: 已阻止访问 /Users/li/.evowork/kernel/x：这是 EvoWork 自己的配置，改它会绕过你设的安全策略。',
          },
          { cmd: 'false', output: 'Process exited with code 1' },
        ],
      }),
    );
    const [turn] = session.turns;
    expect(turn.blocked).toEqual(['这是 EvoWork 自己的配置']);
    expect(turn.failedTools).toBe(1);
    expect(turn.ask).toBe('安装附件里的 SKILL');
    expect(turn.attachments).toHaveLength(1);
  });

  it('上下文峰值取单次请求最大值；中断、上下文溢出、回复里的品牌词都记下来', () => {
    const heavy = summarizeRollout(rollout('s2', { usage: [12_000, 150_000, 90_000] })).turns[0];
    expect(heavy.peakContext).toBe(150_000);
    expect(heavy.requests).toBe(3);
    expect(heavy.flags['heavy-context']).toBe(1);
    expect(summarizeRollout(rollout('s3', { end: 'aborted' })).turns[0]).toMatchObject({
      status: 'interrupted',
      errorCode: 'interrupted',
    });
    expect(summarizeRollout(rollout('s4', { end: 'context' })).turns[0].errorCode).toBe(
      'context_window_exceeded',
    );
    const leak = rollout('s5', {});
    leak.at(-1).payload.last_agent_message = '我是运行在 Codex CLI 里的智能体';
    expect(summarizeRollout(leak).turns[0].flags['brand-in-reply']).toBe(1);
  });

  it('上下文构成按来源分桶：思维链、读文件输出与其他输出分开算，截图不算字符', () => {
    const records = rollout('s7', {
      calls: [
        { cmd: 'sed -n 1,200p reference/pptd.md', output: 'x'.repeat(500) },
        { cmd: 'python3 build.py', output: 'y'.repeat(50) },
      ],
    });
    records.splice(4, 0, {
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'z'.repeat(300) }] },
    });
    records.push({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'img',
        output: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(9999)}` }],
      },
    });
    const { composition } = summarizeRollout(records);
    expect(composition.reasoning).toBe(300);
    expect(composition.fileReads).toBe(500);
    expect(composition.otherOutputs).toBe(50);
  });

  it('认不出的记录种类只计数、不报错 —— 内核改了会话格式时要看得见', () => {
    const records = [...rollout('s6', {}), { type: 'future_record', payload: {} }];
    expect(summarizeRollout(records).unknownTypes).toEqual({ future_record: 1 });
  });
});

describe('汇总与报告', () => {
  const sessions = ['a', 'b', 'c'].map((id, i) =>
    summarizeRollout(
      rollout(`${id}0000000-0000`, {
        // 三次说法都不同：只有附件相同才认得出是同一件事（10-07/08 那份 SKILL.md 就是这样）
        ask: ['附件中SKILL, 请加载到evowork中', '把这个附件SKILL加入到系统中', '安装附件中的SKILL'][
          i
        ],
        attachment: 'SKILL.md',
      }),
    ),
  );

  it('同一个附件出现在多个会话里：认作同一件事做了几遍', () => {
    const report = analyze(sessions);
    expect(report.repeated).toEqual([]);
    expect(report.repeatedAttachments).toHaveLength(1);
    expect(report.repeatedAttachments[0].sessions).toHaveLength(3);
  });

  it('**默认报告里没有任何对话原文与路径**；加 withText 才有', () => {
    const secret = '把客户张三的合同金额 8,888,888 元写进报告';
    const report = analyze([summarizeRollout(rollout('d0000000', { ask: secret }))]);
    const plain = renderMarkdown(report);
    expect(plain).not.toContain('张三');
    expect(plain).not.toContain('私密项目');
    expect(renderMarkdown(report, { withText: true })).toContain('张三');
  });

  it('记忆文件里出现产品注入的附件说明：逐条报出来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evowork-review-'));
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '- 用户说：需要细节时直接读那个文件，不要让我把全文贴出来。\n',
    );
    expect(memoryFindings(dir).map((f) => f.phrase)).toEqual([
      '不要让我把全文贴出来',
      '需要细节时直接读那个文件',
    ]);
  });
});
