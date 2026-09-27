/**
 * 把一个任务的对话序列化成 Markdown —— **分享任务时上传的就是这一份**（08 §7.2 规则 5）。
 *
 * ## 为什么在渲染层做
 *
 * 规则 5 的要点是「不许盲传」：授权模态里要**预览将要上传的内容**。
 * 在这里生成，意味着模态显示的字符串与上传的字符串**是同一个值**，
 * 不是两次各自的推导 —— 那才是"预览的就是要传的"最强的形式。
 * 分两处生成的话，某天一处改了另一处没改，预览就会开始撒谎。
 *
 * ## 为什么要用户先看
 *
 * 用户对"分享一个任务"的直觉是"分享一段对话"，想不到里面还有：
 * 工作空间**路径**、命令与它们的**输出片段**、文件内容摘录、业务数据。
 * 这个函数不替他判断哪些该留 —— 它如实地把要传的东西铺开，让他自己决定。
 */

export interface TranscriptItem {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

/** 每条输出最多留这么多字。太长的命令输出会把预览撑成没人读的一堵墙。 */
const MAX_BLOCK = 2000;

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : undefined,
      )
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

function clip(value: string): string {
  return value.length > MAX_BLOCK
    ? `${value.slice(0, MAX_BLOCK)}\n…（还有 ${value.length - MAX_BLOCK} 字未显示）`
    : value;
}

/**
 * 序列化。**认不出来的条目也写一行**，不是跳过 ——
 * 跳过的话预览里看不到它，而它照样会被传上去（如果它带内容的话）。
 * 写成「（未识别的条目：xxx）」至少让用户知道这里有东西。
 */
export function transcriptToMarkdown(
  title: string,
  items: readonly TranscriptItem[],
  now = new Date(),
): string {
  const lines: string[] = [
    `# ${title || '未命名任务'}`,
    '',
    `> 由 EvoWork 于 ${now.toLocaleString('zh-CN')} 导出。`,
    '',
  ];

  for (const item of items) {
    switch (item.type) {
      case 'userMessage': {
        const body = text(item.content) ?? text(item.text);
        lines.push('## 我说', '', body ? clip(body) : '（空）', '');
        break;
      }
      case 'agentMessage': {
        const body = text(item.content) ?? text(item.text);
        lines.push('## EvoWork', '', body ? clip(body) : '（空）', '');
        break;
      }
      case 'commandExecution': {
        const command = typeof item.command === 'string' ? item.command : '(未知命令)';
        const output = text(item.aggregatedOutput) ?? text(item.output);
        lines.push(
          '### 执行了命令',
          '',
          '```',
          clip(command),
          '```',
          ...(output ? ['', '输出：', '', '```', clip(output), '```'] : []),
          '',
        );
        break;
      }
      case 'fileChange':
      case 'patchApply': {
        const path = typeof item.path === 'string' ? item.path : undefined;
        // **路径本身就是要让用户看见的东西之一**：它会暴露目录结构与项目名
        lines.push(`### 改了文件${path ? `：\`${path}\`` : ''}`, '');
        break;
      }
      case 'reasoning':
        // 思考过程不进导出：它不是给外人看的，而用户也不会预期它被分享
        break;
      default:
        lines.push(`（未识别的条目：${item.type}）`, '');
        break;
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 导出文件名。用任务标题，挡掉路径分隔符。 */
export function transcriptFileName(title: string): string {
  const safe = (title || '未命名任务')
    .replace(/[/\\:*?"<>|]/g, '_')
    .slice(0, 80)
    .trim();
  return `${safe || '未命名任务'}.md`;
}
