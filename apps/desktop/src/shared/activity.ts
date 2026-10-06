/** 基于结构化动作生成展示文案，未知命令不猜测用途。 */
interface ActivityItem {
  readonly type: string;
  readonly [key: string]: unknown;
}
function value(item: ActivityItem, key: string): string {
  return typeof item[key] === 'string' ? item[key] : '';
}
function actions(item: ActivityItem): readonly Record<string, unknown>[] {
  return Array.isArray(item.commandActions)
    ? item.commandActions.filter(
        (action): action is Record<string, unknown> =>
          Boolean(action) && typeof action === 'object',
      )
    : [];
}
export function activityKinds(item: ActivityItem): readonly string[] {
  switch (item.type) {
    case 'commandExecution': {
      const parsed = actions(item);
      return parsed.length > 0
        ? [
            ...new Set(
              parsed.map((action) => {
                switch (action.type) {
                  case 'read':
                    return '读取文件';
                  case 'listFiles':
                    return '查看目录';
                  case 'search':
                    return '搜索文件';
                  default:
                    return '运行命令';
                }
              }),
            ),
          ]
        : ['运行命令'];
    }
    case 'webSearch':
      return ['搜索网页'];
    case 'mcpToolCall': {
      const tool = value(item, 'tool');
      if (tool === 'browser_search') return ['搜索网页'];
      if (tool === 'browser_read_page') return ['读取网页'];
      return ['调用工具'];
    }
    case 'dynamicToolCall':
      return ['调用工具'];
    case 'functionCallOutput':
      return ['接收工具结果'];
    case 'imageView':
      return ['查看图片'];
    case 'sleep':
      return ['等待'];
    case 'subAgentActivity':
    case 'collabAgentToolCall':
      return ['代理协作'];
    default:
      return ['执行操作'];
  }
}
export function activityState(
  item: ActivityItem,
): 'running' | 'completed' | 'failed' | 'interrupted' | 'pending' {
  if (item.interrupted === true || item.status === 'interrupted' || item.status === 'declined')
    return 'interrupted';
  if (item.needsUserAction === true || item.status === 'pending') return 'pending';
  if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0))
    return 'failed';
  return item.completed === true || item.status === 'completed' ? 'completed' : 'running';
}
export function describeActivity(item: ActivityItem): string {
  const state = activityState(item);
  const prefix = state === 'running' ? '正在' : state === 'pending' ? '等待确认：' : '已';
  if (item.type === 'commandExecution') {
    const action = actions(item)[0];
    if (action?.type === 'read') {
      const name =
        typeof action.name === 'string'
          ? action.name
          : typeof action.path === 'string'
            ? action.path
            : '';
      return `${prefix}读取 ${name || '文件'}`;
    }
    if (action?.type === 'listFiles')
      return `${prefix}查看目录${typeof action.path === 'string' ? ` ${action.path}` : ''}`;
    if (action?.type === 'search')
      return `${prefix}搜索文件${typeof action.query === 'string' ? `：${action.query}` : ''}`;
    return `${prefix}运行 ${value(item, 'command') || '命令'}`;
  }
  const detail =
    value(item, 'progress') || value(item, 'query') || value(item, 'tool') || value(item, 'name');
  return `${prefix}${activityKinds(item).join(' · ')}${detail ? `：${detail}` : ''}`;
}

export function activityIcon(item: ActivityItem): string {
  const kind = activityKinds(item)[0];
  if (kind === '读取文件') return 'library';
  if (kind === '查看目录') return 'folder';
  if (kind === '搜索文件' || kind === '搜索网页') return 'search';
  if (kind === '运行命令') return 'code';
  if (kind === '读取网页') return 'compass';
  if (kind === '代理协作') return 'project';
  if (kind === '查看图片') return 'palette';
  if (kind === '等待') return 'automation';
  return 'catalog';
}
