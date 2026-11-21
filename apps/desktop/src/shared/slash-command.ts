import { skillToken } from './skill-token.js';

/** 能从文本识别的本地命令；`new`、`clear` 只从菜单执行（03 §4.3）。 */
const TEXT_COMMANDS = new Set(['goal', 'import', 'memories']);
const TOKEN_END = /^(?:$|[\s.,!?;:，。！？；：、）)\]}])/u;

/**
 * 草稿开头的 `/词` 既不是本地命令、也不是已绑定的技能时返回它。
 *
 * 不拦的话，手输的 `/clear` 会被当成提示词发给模型（03 §4.3）。
 * 路径（`/Users/x/a.md`）与 `//` 开头的文字不算命令。
 */
export function unknownLeadingCommand(
  text: string,
  boundSkillLabels: readonly string[],
): string | undefined {
  const head = text.trimStart();
  if (!head.startsWith('/') || head.startsWith('//')) return undefined;
  for (const label of boundSkillLabels) {
    const token = skillToken(label);
    if (head.startsWith(token) && TOKEN_END.test(head.slice(token.length))) return undefined;
  }
  const match = /^\/(?:skills\/)?[^\s/]+(?=\s|$)/u.exec(head);
  if (!match) return undefined;
  return TEXT_COMMANDS.has(match[0].slice(1)) ? undefined : match[0];
}
