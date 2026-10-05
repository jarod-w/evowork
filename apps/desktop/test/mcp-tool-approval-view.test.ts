/**
 * 内核 MCP 工具审批卡上的话（12 §7.4：在哪个应用、对哪个目标、执行什么、会发送哪些数据）。
 * 内核只给一句英文兜底，2026-10-05 真窗口 E2E 里那张卡就照搬了它，而且批不了。
 */
import { describe, expect, it } from 'vitest';

import { describeMcpToolApproval } from '../src/main/mcp-tool-approval-view.js';
import { toApprovalView } from '../src/main/renderer-bridge.js';

const message = 'Allow the cua_repl MCP server to run tool "set_value"?';

describe('电脑操控写动作：说清应用、目标与要发送的内容', () => {
  it('填入内容：应用、元素、正文都在卡上', () => {
    const described = describeMcpToolApproval({
      server: 'cua_repl',
      message,
      call: {
        server: 'cua_repl',
        tool: 'set_value',
        arguments: {
          app: 'com.apple.TextEdit',
          state_id: 's',
          element_index: 2,
          value: '周报草稿',
        },
      },
    });
    expect(described.impact).toBe('电脑操控将在 com.apple.TextEdit 上填入内容');
    expect(described.scope).toEqual(['目标：界面元素 #2', '内容：「周报草稿」']);
    // 应用准入不代替动作审批（12 §7.2 / §7.3）—— 卡上要让用户知道这一步是单独批的
    expect(described.reason).toContain('允许访问这个应用不等于允许这一步');
    expect(JSON.stringify(described)).not.toContain('Allow the');
  });

  it('按键与坐标点击各说各的', () => {
    expect(
      describeMcpToolApproval({
        server: 'cua_repl',
        call: {
          server: 'cua_repl',
          tool: 'press_key',
          arguments: { app: 'com.apple.TextEdit', state_id: 's', key: 'Meta+S' },
        },
      }).scope,
    ).toEqual(['按键：Meta+S']);
    expect(
      describeMcpToolApproval({
        server: 'cua_repl',
        call: {
          server: 'cua_repl',
          tool: 'click',
          arguments: { app: 'com.apple.Finder', state_id: 's', x: 12, y: 40 },
        },
      }),
    ).toMatchObject({
      impact: '电脑操控将在 com.apple.Finder 上点击',
      scope: ['目标：窗口坐标 (12, 40)'],
    });
  });

  it('长正文截断成一行，不把整篇文档摊在卡上', () => {
    const [line] = describeMcpToolApproval({
      server: 'cua_repl',
      call: {
        server: 'cua_repl',
        tool: 'type_text',
        arguments: { app: 'a', state_id: 's', text: `第一行\n${'字'.repeat(500)}` },
      },
    }).scope;
    expect(line).not.toContain('\n');
    expect(line?.length).toBeLessThan(220);
    expect(line?.endsWith('…」')).toBe(true);
  });

  it('认不出是哪次调用：照实说认不出，工具名退到内核那句英文里的引号', () => {
    const described = describeMcpToolApproval({ server: 'cua_repl', message });
    expect(described.impact).toBe('电脑操控将在 （未知应用） 上填入内容');
    expect(described.scope).toEqual(['参数：没能认出这次调用的参数']);
  });
});

describe('别的连接器：连接器、工具、参数', () => {
  it('用工具标题与说明；参数逐项列出，多了只说还有几个', () => {
    const described = describeMcpToolApproval({
      server: 'crm',
      toolTitle: '创建客户',
      toolDescription: '在 CRM 里新建一条客户记录',
      call: {
        server: 'crm',
        tool: 'create_customer',
        arguments: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 },
      },
    });
    expect(described.impact).toBe('将运行连接器「crm」的工具「创建客户」');
    expect(described.reason).toBe('在 CRM 里新建一条客户记录');
    expect(described.scope).toHaveLength(7);
    expect(described.scope.at(-1)).toBe('另有 1 个参数');
  });
});

describe('审批卡的视图：内核的工具审批画成确认卡，不是「暂不支持」的表单', () => {
  it('带 toolCall、影响与原因；没有 question / options', () => {
    const view = toApprovalView(
      {
        id: 'apv_1',
        kind: 'mcp',
        threadId: 't1',
        receivedAtMs: 0,
        unattended: false,
        params: {
          threadId: 't1',
          serverName: 'cua_repl',
          mode: 'form',
          message,
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call' },
        },
        mcpToolCall: {
          server: 'cua_repl',
          tool: 'set_value',
          arguments: { app: 'com.apple.TextEdit', element_index: 2, value: '周报' },
        },
      },
      false,
      0,
    );
    expect(view.toolCall?.scope).toEqual(['目标：界面元素 #2', '内容：「周报」']);
    expect(view.impact).toBe('电脑操控将在 com.apple.TextEdit 上填入内容');
    expect(view.reason).toBeTruthy();
    expect(view.question).toBeUndefined();
    expect(view.options).toBeUndefined();
  });

  it('MCP server 自己的表单照旧走 question / options', () => {
    const view = toApprovalView(
      {
        id: 'apv_2',
        kind: 'mcp',
        threadId: 't1',
        receivedAtMs: 0,
        unattended: false,
        params: {
          serverName: 'cua_repl',
          mode: 'form',
          message: '允许 EvoWork 读取并操作 TextEdit？',
          requestedSchema: {
            type: 'object',
            properties: { scope: { type: 'string', enum: ['task', 'deny'] } },
            required: ['scope'],
          },
        },
      },
      false,
      0,
    );
    expect(view.toolCall).toBeUndefined();
    expect(view.options?.map((option) => option.label)).toEqual(['仅本次任务', '不允许']);
  });
});
