/** 技能来源（05 §3.2：角标必须能一眼看出是谁给的）。 */
export type SkillSource = 'official' | 'private' | 'local' | 'git';

export type RiskLevel = 'p0' | 'p1' | 'p2';

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

/** 展示元数据。不进内核解析路径；缺了就用 frontmatter。 */
export interface SkillInterface {
  readonly displayName: string;
  readonly category: string;
  readonly brandColor?: string | undefined;
  readonly defaultPrompt?: string | undefined;
}

export interface SkillRecord {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly installed: boolean;
  readonly featured: boolean;
  readonly interface: SkillInterface;
  readonly audit: AuditResult;
}

export interface AuditFinding {
  readonly code: string;
  readonly detail: string;
}

export interface AuditResult {
  readonly level: RiskLevel;
  readonly findings: readonly AuditFinding[];
  /** P2 时必须写清"最坏能做什么"。P0/P1 可空。 */
  readonly worstCase?: string | undefined;
}

export type ConnectorKind = 'official' | 'custom';
export type ConnectorTransport = 'stdio' | 'sse' | 'http';
export type ConnectorStatus =
  'untrusted' | 'disconnected' | 'connected' | 'needs-auth' | 'failed' | 'disabled';

export type ToolPolicy = 'approve' | 'allow';

export interface ConnectorRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectorKind;
  readonly transport: ConnectorTransport;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
  /** 环境变量**名**。值不进视图。 */
  readonly envKeys?: readonly string[] | undefined;
  readonly trusted: boolean;
  readonly status: ConnectorStatus;
  readonly category: 'browser' | 'custom';
  readonly toolCount?: number | undefined;
  readonly toolPolicy: Readonly<Record<string, ToolPolicy>>;
  readonly failureSummary?: string | undefined;
  readonly disabledReason?: string | undefined;
}

export interface ExpertInterface {
  readonly displayName: string;
  readonly category: string;
  readonly sampleTasks: readonly string[];
}

export interface ExpertRecord {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'official' | 'local';
  readonly installed: boolean;
  readonly interface: ExpertInterface;
  readonly model?: string | undefined;
  readonly instructions?: string | undefined;
}

/** 「发现应用」= 带 interface 的已装 bundle（05 §6）。 */
export interface AppRecord {
  readonly id: string;
  readonly kind: 'skill' | 'connector';
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly defaultPrompt?: string | undefined;
  readonly brandColor?: string | undefined;
}
