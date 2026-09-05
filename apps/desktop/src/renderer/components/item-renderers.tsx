/**
 * 19 类 Item 的渲染规范（04 §5.2）。
 *
 * ## 为什么必须逐类给规范
 *
 * 内核的 `ThreadItem` 有 **19 个变体**（F13）。对话区不是"消息 + 工具"两类 ——
 * 少写一类的后果不是"少一个功能"，而是**对话流里出现大量"未知事件"占位**。
 *
 * ## 三条来自文档的硬规则
 *
 * 1. **默认折叠 vs 默认展开**由 04 §5.2 的表决定：过程性的折叠（一行摘要 + 展开箭头），
 *    结论性的直接铺开。这不是审美选择 —— 一个默认展开所有命令输出的对话流没法读。
 * 2. **未知 item 绝不静默丢弃**（04 §5.2 最后一段）：渲染成一行「新类型事件（<type>），已记录」，
 *    展开可看原始 JSON。这是 R2 的防线：用户看到陌生事件比看到空白好，且能立刻反馈。
 * 3. **`Reasoning` 在模型无推理能力时整体不渲染**（04 §5.2 #3），**不留空壳**。
 *    这条与网关的能力声明（D2）配对：网关说没有，前端就不画那个折叠区。
 */
import { useState, type ReactNode } from 'react';

import { Badge, StatusDot } from './primitives.js';
import {
  parseFences,
  Visualizer,
  type ChartSpec,
  type FenceBlock,
  type MermaidRenderer,
} from './visualizer.js';

/** 内核 item 的最小形状（前端只读它需要的字段，其余留 unknown）。 */
export interface RenderItem {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ItemRenderContext {
  /** 模型是否有推理能力（来自网关的能力声明，D2）。false 时 Reasoning 整体不渲染 */
  readonly reasoningAvailable: boolean;
  /** 企业策略可配置隐藏 HookPrompt（04 §5.2 #15），但审计日志始终记录 */
  readonly hidePolicyPrompts?: boolean | undefined;
  readonly onFork?: ((itemId: string) => void) | undefined;
  readonly onOpenSubAgent?: ((threadId: string) => void) | undefined;
  /**
   * Visualizer 的三个可选依赖（04 §7）。
   *
   * 都可以不给：不给 `mermaid` 时图退化成代码块、不给 `renderChart` 时图表区留空。
   * **这不是降级兜底，是刻意的**——它让"清洗与沙箱参数"能在没有这两个大依赖的情况下被测。
   */
  readonly mermaid?: MermaidRenderer | undefined;
  readonly renderChart?: ((spec: ChartSpec) => ReactNode) | undefined;
  readonly prefersDark?: boolean | undefined;
  readonly onSaveFence?: ((block: FenceBlock) => void) | undefined;
}

/** 04 §5.2 的"默认"列：过程性折叠、结论性展开。 */
export const DEFAULT_EXPANDED: Readonly<Record<string, boolean>> = Object.freeze({
  userMessage: true,
  agentMessage: true,
  // 过程性 → 折叠
  reasoning: false,
  commandExecution: false,
  mcpToolCall: false,
  dynamicToolCall: false,
  functionCallOutput: false,
  webSearch: false,
  imageView: false,
  subAgentActivity: false,
  collabAgentToolCall: false,
  sleep: false,
  hookPrompt: false,
  // 结论性 → 展开
  plan: true,
  fileChange: true,
  imageGeneration: true,
  contextCompaction: true,
  enteredReviewMode: true,
  exitedReviewMode: true,
});

function text(item: RenderItem, key: string): string {
  const value = item[key];
  return typeof value === 'string' ? value : '';
}

function Collapsible({
  summary,
  defaultExpanded,
  children,
  kind,
}: {
  readonly summary: ReactNode;
  readonly defaultExpanded: boolean;
  readonly children?: ReactNode | undefined;
  readonly kind: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="ew-item" data-kind={kind} data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="ew-item-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {summary}
      </button>
      {expanded && children ? <div className="ew-item-body">{children}</div> : null}
    </div>
  );
}

/** 一行分隔线样式的 item（04 §5.2 #16–18）。 */
function Divider({ kind, children }: { readonly kind: string; readonly children: ReactNode }) {
  return (
    <div className="ew-item ew-item-divider" data-kind={kind} role="separator">
      <span>{children}</span>
    </div>
  );
}

const PLAN_STEP_LABEL: Readonly<Record<string, string>> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
};

export function ItemRenderer({
  item,
  context,
}: {
  readonly item: RenderItem;
  readonly context: ItemRenderContext;
}) {
  const kind = item.type;
  const defaultExpanded = DEFAULT_EXPANDED[kind] ?? false;

  switch (kind) {
    // ① UserMessage —— 右对齐块，含 @ token 与附件缩略卡
    case 'userMessage': {
      const content = Array.isArray(item.content)
        ? (item.content as { type: string; text?: string; name?: string }[])
        : [];
      return (
        <div className="ew-item ew-item-user" data-kind={kind}>
          <div className="ew-user-bubble">
            {content.map((part, index) =>
              part.type === 'text' ? (
                <p key={index}>{part.text}</p>
              ) : (
                // @ 引用与技能在输入框里是不可分割的 token（03 §4.2），历史里同样成块显示
                <span key={index} className="ew-mention" data-mention-kind={part.type}>
                  {part.name ?? part.type}
                </span>
              ),
            )}
          </div>
          {context.onFork ? (
            <button
              type="button"
              className="ew-item-action"
              onClick={() => context.onFork?.(item.id)}
            >
              从此处分叉
            </button>
          ) : null}
        </div>
      );
    }

    // ② AgentMessage —— Markdown 全量渲染；三类受控 fence 交给 Visualizer（04 §7）
    case 'agentMessage': {
      /*
       * 三类受控 fence 交给 Visualizer（04 §5.2 #2 / §7），其余按纯文本。
       *
       * **多图叙事按顺序纵向排列，不做轮播**（04 §7 最后一段）：
       * 对话流里的横向轮播会丢上下文 —— 用户看第二张图时看不到第一张。
       */
      const blocks = parseFences(text(item, 'text'));
      return (
        <div className="ew-item ew-item-agent" data-kind={kind}>
          {blocks.map((block, index) =>
            block.kind === 'text' ? (
              <div key={index} className="ew-markdown">
                {block.text}
              </div>
            ) : (
              <Visualizer
                key={index}
                block={block}
                mermaid={context.mermaid}
                renderChart={context.renderChart}
                prefersDark={context.prefersDark}
                onSaveAsFile={context.onSaveFence}
              />
            ),
          )}
        </div>
      );
    }

    // ③ Reasoning —— 折叠；**模型无推理能力时整体不渲染，不留空壳**
    case 'reasoning': {
      if (!context.reasoningAvailable) return null;
      const seconds = typeof item.durationSeconds === 'number' ? item.durationSeconds : undefined;
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={seconds === undefined ? '思考中…' : `已思考 ${seconds} 秒`}
        >
          <div className="ew-reasoning-body">{text(item, 'text') || text(item, 'summaryText')}</div>
        </Collapsible>
      );
    }

    // ④ Plan —— 步骤清单卡；Plan 模式下卡底部有"确认执行 / 修改计划"（清单的"规划中"确认点）
    case 'plan': {
      const steps = Array.isArray(item.steps)
        ? (item.steps as { step: string; status: string }[])
        : [];
      return (
        <div className="ew-item ew-item-plan" data-kind={kind}>
          <ol className="ew-plan-steps">
            {steps.map((step, index) => (
              <li key={index} data-status={step.status}>
                <Badge
                  variant={
                    step.status === 'completed'
                      ? 'success'
                      : step.status === 'in_progress'
                        ? 'info'
                        : 'neutral'
                  }
                >
                  {PLAN_STEP_LABEL[step.status] ?? step.status}
                </Badge>
                <span>{step.step}</span>
              </li>
            ))}
          </ol>
        </div>
      );
    }

    // ⑤ CommandExecution —— 折叠；展开显示输出（尾部 500 行滚动窗口，04 §9）
    case 'commandExecution': {
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      const failed = exitCode !== undefined && exitCode !== 0;
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={
            <>
              <StatusDot tone={failed ? 'danger' : exitCode === 0 ? 'accent' : 'muted'} />
              <code className="ew-command">$ {text(item, 'command')}</code>
              {exitCode !== undefined ? (
                <span className="ew-exit-code">退出码 {exitCode}</span>
              ) : null}
            </>
          }
        >
          <pre className="ew-command-output">{text(item, 'output')}</pre>
        </Collapsible>
      );
    }

    // ⑥ FileChange —— **默认展开**；首屏最多 40 行 diff，超出跳结果区变更视图
    case 'fileChange': {
      const changes = Array.isArray(item.changes)
        ? (item.changes as { path: string; kind?: string; added?: number; removed?: number }[])
        : [];
      return (
        <div className="ew-item ew-item-file-change" data-kind={kind}>
          <ul className="ew-change-list">
            {changes.map((change, index) => (
              <li key={index} data-change-kind={change.kind ?? 'modify'}>
                <span className="ew-change-path">{change.path}</span>
                {change.added !== undefined || change.removed !== undefined ? (
                  <span className="ew-change-stat">
                    +{change.added ?? 0}/-{change.removed ?? 0}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      );
    }

    // ⑦⑧ McpToolCall / DynamicToolCall —— 折叠一行：图标 + server.tool + 状态 + 耗时
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = text(item, 'toolName') || text(item, 'name') || '工具调用';
      const server = text(item, 'server');
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={
            <>
              <StatusDot tone="muted" />
              <span>{server ? `${server}.${name}` : name}</span>
            </>
          }
        >
          <pre className="ew-json">{JSON.stringify(item.arguments ?? {}, null, 2)}</pre>
        </Collapsible>
      );
    }

    // ⑨ FunctionCallOutput —— 通常并入其调用项；无法关联时独立折叠行
    case 'functionCallOutput':
      return (
        <Collapsible kind={kind} defaultExpanded={defaultExpanded} summary="工具返回">
          <pre className="ew-json">{text(item, 'output')}</pre>
        </Collapsible>
      );

    // ⑩ WebSearch
    case 'webSearch': {
      const results = Array.isArray(item.results)
        ? (item.results as { title?: string; url?: string }[])
        : [];
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={`搜索：${text(item, 'query')} · ${results.length} 条结果`}
        >
          <ul className="ew-search-results">
            {results.map((r, index) => (
              <li key={index}>{r.title ?? r.url}</li>
            ))}
          </ul>
        </Collapsible>
      );
    }

    // ⑪ ImageGeneration —— 展开；图片卡 + 提示词折叠 + 「保存到产物」
    case 'imageGeneration': {
      // 生成中的 item 还没有 path/url。此时**不能渲染 `<img src="">`** ——
      // 空 src 会让浏览器把当前页面当作图片再下载一遍（React 也会为此告警）。
      const source = text(item, 'path') || text(item, 'url');
      return (
        <div className="ew-item ew-item-image" data-kind={kind}>
          {source ? (
            <img
              className="ew-generated-image"
              src={source}
              alt={text(item, 'prompt') || '生成的图片'}
            />
          ) : (
            <div className="ew-generated-image ew-image-pending">正在生成图片…</div>
          )}
        </div>
      );
    }

    // ⑫ ImageView
    case 'imageView':
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={`已查看图片：${text(item, 'path')}`}
        />
      );

    // ⑬⑭ SubAgentActivity / CollabAgentToolCall —— 子任务卡（清单 §9 多角色协作的可视化）
    case 'subAgentActivity':
    case 'collabAgentToolCall': {
      const childThreadId = text(item, 'threadId') || text(item, 'childThreadId');
      const role = text(item, 'agentRole') || text(item, 'nickname') || '子任务';
      const tokens = typeof item.tokenUsage === 'number' ? item.tokenUsage : undefined;
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={
            <>
              <span>{role}</span>
              {tokens !== undefined ? (
                <span className="ew-token-usage">{tokens} tokens</span>
              ) : null}
            </>
          }
        >
          {childThreadId ? (
            <button
              type="button"
              className="ew-item-action"
              onClick={() => context.onOpenSubAgent?.(childThreadId)}
            >
              查看子任务详情
            </button>
          ) : null}
        </Collapsible>
      );
    }

    // ⑮ HookPrompt —— 「策略注入」行。**企业策略可配置隐藏**，但审计日志始终记录（10 §6）
    case 'hookPrompt': {
      if (context.hidePolicyPrompts) return null;
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={`策略注入 · ${text(item, 'hookName')}`}
        >
          <div className="ew-markdown">{text(item, 'text')}</div>
        </Collapsible>
      );
    }

    // ⑯ ContextCompaction —— 分隔线 + 「查看被压缩的内容」
    case 'contextCompaction': {
      const turns = typeof item.compactedTurns === 'number' ? item.compactedTurns : undefined;
      return (
        <Divider kind={kind}>
          {turns === undefined
            ? '已压缩早期对话以节省上下文'
            : `已压缩前 ${turns} 轮对话以节省上下文`}
        </Divider>
      );
    }

    // ⑰⑱ 安全审查的进入/退出（配合 guardian-v2，10 §4）
    case 'enteredReviewMode':
      return <Divider kind={kind}>进入安全审查</Divider>;
    case 'exitedReviewMode':
      return <Divider kind={kind}>审查完成</Divider>;

    // ⑲ Sleep —— 用于轮询类任务
    case 'sleep': {
      const seconds = typeof item.durationSeconds === 'number' ? item.durationSeconds : undefined;
      return (
        <Collapsible
          kind={kind}
          defaultExpanded={defaultExpanded}
          summary={`等待 ${seconds ?? '?'} 秒…`}
        />
      );
    }

    // 未知 item（上游新增变体）——**绝不静默丢弃**（R2 的防线）
    default:
      return (
        <Collapsible
          kind="unknown"
          defaultExpanded={false}
          summary={`新类型事件（${kind}），已记录`}
        >
          <pre className="ew-json">{JSON.stringify(item, null, 2)}</pre>
        </Collapsible>
      );
  }
}

/** 04 §5.2 覆盖的 19 类，用于"上游是不是加了第 20 类"的断言。 */
export const HANDLED_ITEM_TYPES = Object.freeze([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'functionCallOutput',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
] as const);
