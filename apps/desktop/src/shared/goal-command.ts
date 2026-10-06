/** Composer 与宿主共用解析，控制命令不进入模型提示词。 */
export type GoalCommand =
  | { readonly action: 'show' | 'pause' | 'resume' | 'clear' }
  | { readonly action: 'create'; readonly objective: string };

export function parseGoalCommand(text: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  const objective = match[1]?.trim() ?? '';
  if (!objective) return { action: 'show' };
  if (objective === 'pause' || objective === 'resume' || objective === 'clear')
    return { action: objective };
  return { action: 'create', objective };
}

export const GOAL_STATUS_LABELS = {
  active: '持续推进中',
  paused: '已暂停',
  blocked: '等待解除阻塞',
  usageLimited: '已达用量限制',
  budgetLimited: '预算已耗尽',
  complete: '已完成',
} as const;
