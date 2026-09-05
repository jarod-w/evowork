/**
 * 19 类 Item 的渲染规范（04 §5.2）逐条测。
 *
 * 这些测试盯的是**规范里明确写了"必须/不得"的地方**，而不是 DOM 结构细节：
 * 默认折叠/展开、未知类型不丢弃、无推理能力时不留空壳、企业策略可隐藏策略注入。
 * DOM 结构会随视觉调整而变，那些约束不会。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EXPANDED,
  HANDLED_ITEM_TYPES,
  ItemRenderer,
  type ItemRenderContext,
  type RenderItem,
} from '../src/renderer/components/item-renderers.js';

const CTX: ItemRenderContext = { reasoningAvailable: true };

function renderItem(item: RenderItem, context: Partial<ItemRenderContext> = {}) {
  return render(<ItemRenderer item={item} context={{ ...CTX, ...context }} />);
}

describe('覆盖面：19 类一个不少（F13）', () => {
  it('HANDLED_ITEM_TYPES 正好 19 类', () => {
    expect(HANDLED_ITEM_TYPES).toHaveLength(19);
  });

  it('每一类都能渲染出东西（不会因为缺字段而崩）', () => {
    for (const type of HANDLED_ITEM_TYPES) {
      const { container, unmount } = renderItem({ id: `i-${type}`, type });
      // reasoning 在有能力时应渲染；其余都必须有节点
      expect(container.firstChild, `${type} 渲染为空`).not.toBeNull();
      unmount();
    }
  });

  it('默认折叠/展开与 04 §5.2 的表一致', () => {
    // 结论性 → 展开
    for (const type of ['userMessage', 'agentMessage', 'plan', 'fileChange', 'imageGeneration']) {
      expect(DEFAULT_EXPANDED[type], `${type} 应默认展开`).toBe(true);
    }
    // 过程性 → 折叠
    for (const type of [
      'reasoning',
      'commandExecution',
      'mcpToolCall',
      'webSearch',
      'subAgentActivity',
      'sleep',
    ]) {
      expect(DEFAULT_EXPANDED[type], `${type} 应默认折叠`).toBe(false);
    }
  });
});

describe('未知 item：**绝不静默丢弃**（04 §5.2 最后一段，R2 的防线）', () => {
  it('渲染成一行「新类型事件」并可展开看原始 JSON', () => {
    renderItem({ id: 'i1', type: 'someBrandNewKind', payload: { a: 1 } });
    const summary = screen.getByRole('button', { name: /新类型事件（someBrandNewKind），已记录/ });
    expect(summary).toBeTruthy();
    expect(summary.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(summary);
    // 展开后能看到原始 JSON —— 用户能把它反馈给我们。
    // 用 .ew-json 定位而不是文本匹配：摘要行本身也含类型名
    const raw = document.querySelector('.ew-json');
    expect(raw?.textContent).toContain('someBrandNewKind');
    expect(raw?.textContent).toContain('payload');
  });
});

describe('Reasoning：模型无推理能力时**整体不渲染，不留空壳**（04 §5.2 #3）', () => {
  it('有能力 → 渲染折叠行', () => {
    const { container } = renderItem({
      id: 'i1',
      type: 'reasoning',
      durationSeconds: 12,
      text: '先看表头',
    });
    expect(container.querySelector('[data-kind="reasoning"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /已思考 12 秒/ })).toBeTruthy();
  });

  it('无能力 → **什么都不渲染**（这与网关的能力声明配对，D2）', () => {
    const { container } = renderItem(
      { id: 'i1', type: 'reasoning', text: '不该出现' },
      { reasoningAvailable: false },
    );
    expect(container.firstChild).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('CommandExecution（04 §5.2 #5）', () => {
  it('折叠行显示命令与退出码；展开后才显示输出', () => {
    renderItem({
      id: 'i1',
      type: 'commandExecution',
      command: 'pip install openpyxl',
      exitCode: 0,
      output: 'Successfully installed openpyxl',
    });
    const summary = screen.getByRole('button');
    expect(summary.textContent).toContain('pip install openpyxl');
    expect(summary.textContent).toContain('退出码 0');
    // 折叠时输出不在 DOM 里（长输出不渲染是 04 §9 的性能约束）
    expect(screen.queryByText(/Successfully installed/)).toBeNull();

    fireEvent.click(summary);
    expect(screen.getByText(/Successfully installed/)).toBeTruthy();
  });

  it('非零退出码用 danger 状态点', () => {
    const { container } = renderItem({
      id: 'i1',
      type: 'commandExecution',
      command: 'x',
      exitCode: 1,
    });
    expect(container.querySelector('[data-tone="danger"]')).not.toBeNull();
  });
});

describe('FileChange：**默认展开**，且带 +n/-m 统计（04 §5.2 #6）', () => {
  it('直接铺开变更列表', () => {
    renderItem({
      id: 'i1',
      type: 'fileChange',
      changes: [
        { path: '/w/report.docx', kind: 'add' },
        { path: '/w/data/2026.csv', kind: 'modify', added: 12, removed: 0 },
      ],
    });
    expect(screen.getByText('/w/report.docx')).toBeTruthy();
    expect(screen.getByText('+12/-0')).toBeTruthy();
  });
});

describe('Plan：三态步骤（04 §5.2 #4）', () => {
  it('每步显示 pending / in_progress / completed', () => {
    renderItem({
      id: 'i1',
      type: 'plan',
      steps: [
        { step: '读三张表的表头', status: 'completed' },
        { step: '按季度分组', status: 'in_progress' },
        { step: '生成 pptx', status: 'pending' },
      ],
    });
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
  });
});

describe('HookPrompt：企业策略可隐藏，但**审计日志始终记录**（04 §5.2 #15）', () => {
  it('默认显示', () => {
    renderItem({ id: 'i1', type: 'hookPrompt', hookName: 'pre_tool_use', text: '注入的策略文本' });
    expect(screen.getByRole('button', { name: /策略注入 · pre_tool_use/ })).toBeTruthy();
  });

  it('企业策略配置隐藏时不渲染（避免暴露内部策略文本）', () => {
    const { container } = renderItem(
      { id: 'i1', type: 'hookPrompt', hookName: 'pre_tool_use', text: '内部策略' },
      { hidePolicyPrompts: true },
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('ContextCompaction 与审查分隔线（04 §5.2 #16–18）', () => {
  it('压缩显示压了多少轮 + 分隔线语义', () => {
    const { container } = renderItem({ id: 'i1', type: 'contextCompaction', compactedTurns: 42 });
    expect(screen.getByText(/已压缩前 42 轮对话/)).toBeTruthy();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('进入/退出安全审查各一行（配合 guardian-v2）', () => {
    const { unmount } = renderItem({ id: 'i1', type: 'enteredReviewMode' });
    expect(screen.getByText('进入安全审查')).toBeTruthy();
    unmount();
    renderItem({ id: 'i2', type: 'exitedReviewMode' });
    expect(screen.getByText('审查完成')).toBeTruthy();
  });
});

describe('SubAgentActivity：子任务卡（清单 §9 多角色协作的可视化）', () => {
  it('折叠行显示角色与 token 用量；展开可跳子任务', () => {
    const onOpenSubAgent = vi.fn();
    renderItem(
      {
        id: 'i1',
        type: 'subAgentActivity',
        agentRole: 'finance-analyst',
        tokenUsage: 4200,
        threadId: 'child-1',
      },
      { onOpenSubAgent },
    );
    const summary = screen.getByRole('button');
    expect(summary.textContent).toContain('finance-analyst');
    expect(summary.textContent).toContain('4200 tokens');

    fireEvent.click(summary);
    fireEvent.click(screen.getByRole('button', { name: '查看子任务详情' }));
    expect(onOpenSubAgent).toHaveBeenCalledWith('child-1');
  });
});

describe('UserMessage：@ 引用成块显示（03 §4.2 的 token 在历史里保真）', () => {
  it('文本与 mention 分别渲染', () => {
    renderItem({
      id: 'i1',
      type: 'userMessage',
      content: [
        { type: 'text', text: '按这个模板做：' },
        { type: 'skill', name: 'presentations' },
        { type: 'mention', name: 'Q3.xlsx' },
      ],
    });
    expect(screen.getByText('按这个模板做：')).toBeTruthy();
    const mentions = document.querySelectorAll('.ew-mention');
    expect(mentions).toHaveLength(2);
    expect(within(mentions[0] as HTMLElement).getByText('presentations')).toBeTruthy();
  });

  it('提供分叉回调时显示「从此处分叉」（04 §5.2 #1）', () => {
    const onFork = vi.fn();
    renderItem({ id: 'i1', type: 'userMessage', content: [] }, { onFork });
    fireEvent.click(screen.getByRole('button', { name: '从此处分叉' }));
    expect(onFork).toHaveBeenCalledWith('i1');
  });

  /**
   * 生成中的图片没有 path/url。`<img src="">` 会让浏览器把当前文档当图片重新请求一遍 ——
   * 在 Electron 里这意味着一次多余的整页加载，而症状只是一条控制台告警，很容易被放过去。
   */
  it('图片还没生成出来时不渲染空 src 的 img，而是给占位', () => {
    renderItem({ id: 'i1', type: 'imageGeneration', prompt: '一张折线图' });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('正在生成图片…')).toBeTruthy();
  });

  it('图片就位后渲染 img，alt 用提示词', () => {
    renderItem({ id: 'i1', type: 'imageGeneration', prompt: '一张折线图', path: '/w/a.png' });
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/w/a.png');
    expect(img?.getAttribute('alt')).toBe('一张折线图');
  });
});
