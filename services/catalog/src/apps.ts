import type { AppRecord, ConnectorRecord, SkillRecord } from './types.js';

/** 发现应用 = 已装且带展示元数据的 bundle（05 §6）。连接器未信任的不算「已装应用」。 */
export function listApps(
  skills: readonly SkillRecord[],
  connectors: readonly ConnectorRecord[],
): readonly AppRecord[] {
  const fromSkills: AppRecord[] = skills
    .filter((s) => s.installed)
    .map((s) => ({
      id: `skill:${s.id}`,
      kind: 'skill' as const,
      displayName: s.interface.displayName,
      description: s.description,
      category: s.interface.category,
      ...(s.interface.defaultPrompt !== undefined
        ? { defaultPrompt: s.interface.defaultPrompt }
        : {}),
      ...(s.interface.brandColor !== undefined ? { brandColor: s.interface.brandColor } : {}),
    }));
  const fromConnectors: AppRecord[] = connectors
    .filter((c) => c.trusted)
    .map((c) => ({
      id: `connector:${c.id}`,
      kind: 'connector' as const,
      displayName: c.name,
      description: c.kind === 'official' ? '官方连接器' : '自建 MCP',
      category: c.category === 'browser' ? '浏览器' : '自建',
    }));
  return [...fromSkills, ...fromConnectors];
}
