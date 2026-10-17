/** 本地命令保留其名字；同名技能用路径前缀避免在发送时被当成本地操作。 */
export function skillToken(label: string): string {
  return /^\/(?:goal|import|memories)(?:\s|$)/u.test(`/${label}`)
    ? `/skills/${label}`
    : `/${label}`;
}
