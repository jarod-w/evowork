/** 只生成内核认识的 MCP 配置。认证值永远不写盘。 */
export function patchComputerUseConfig(
  text: string,
  nodeCommand: string,
  entry: string,
  enabled: boolean,
): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
    if (section)
      skipping = section === 'mcp_servers.cua_repl' || section.startsWith('mcp_servers.cua_repl.');
    if (!skipping) kept.push(line);
  }
  return `${kept.join('\n').trimEnd()}\n\n[mcp_servers.cua_repl]\ncommand = ${JSON.stringify(nodeCommand)}\nargs = [${JSON.stringify(entry)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenv_vars = ["EVOWORK_CUA_SOCKET", "EVOWORK_CUA_SESSION_TOKEN"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 30\ndefault_tools_approval_mode = "writes"\nenabled = ${enabled}\n`;
}
