/**
 * 安装时静态审计（05 §3.3）。
 *
 * **不执行**被审计目录里的任何代码。判定只看文件名与文本内容。
 * 缺文件列表时按最严（P2）—— 读不到就等于能力面未知。
 */
import type { AuditFinding, AuditResult, RiskLevel } from './types.js';

const P2_BIN_EXT = ['.exe', '.dll', '.so', '.dylib', '.bin', '.wasm'];
const SENSITIVE_PATH = /(?:^|[^\w.])(?:\/etc\/|\/root\/|~\/\.ssh|~\.ssh|\.ssh\/|\/proc\/)/i;
const ARBITRARY_NET =
  /(?:network\s*[:=]\s*(?:any|\*)|danger-full-access|allow_all_unix|permissions\s*[:=]\s*["']?\*)/i;
const LIMITED_NET = /(?:https?:\/\/[^\s]+|network_access|mcp_servers?)/i;
const SHELL_HINT = /(?:\b(bash|sh|zsh|powershell|cmd\.exe|os\.system|subprocess)\b)/i;

export interface AuditFile {
  readonly relativePath: string;
  /** 文本文件的正文。二进制或不读内容时缺省。 */
  readonly text?: string | undefined;
}

export function auditSkillFiles(files: readonly AuditFile[]): AuditResult {
  if (files.length === 0) {
    return {
      level: 'p2',
      findings: [{ code: 'empty', detail: '目录是空的，能力面未知。' }],
      worstCase: '无法判断它会读写哪些路径、会不会出网或装钩子。',
    };
  }

  const findings: AuditFinding[] = [];
  let level: RiskLevel = 'p0';
  let worst: string | undefined;

  const raise = (next: RiskLevel, finding: AuditFinding, worstCase?: string) => {
    findings.push(finding);
    if (rank(next) > rank(level)) {
      level = next;
      if (worstCase !== undefined) worst = worstCase;
    } else if (worstCase !== undefined && level === 'p2' && worst === undefined) {
      worst = worstCase;
    }
  };

  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    const base = lower.split(/[/\\]/).pop() ?? lower;

    if (base === 'hooks.json' || lower.includes('/hooks/')) {
      raise(
        'p2',
        { code: 'hooks', detail: `${file.relativePath} 声明了 hooks，可拦截所有工具调用。` },
        '它可以在每一次工具调用前后插入自己的逻辑，包括改参数和静默放行。',
      );
    }

    if (P2_BIN_EXT.some((ext) => lower.endsWith(ext))) {
      raise(
        'p2',
        { code: 'binary', detail: `${file.relativePath} 是二进制。` },
        '二进制无法静态穷举能力面，安装后实际能做的事比声明的更多。',
      );
    }

    const text = file.text ?? '';
    if (text !== '' && ARBITRARY_NET.test(text)) {
      raise(
        'p2',
        { code: 'unrestricted-network', detail: `${file.relativePath} 声明了任意网络或完全访问。` },
        '它可以访问任意网络或拿到完全访问权限。',
      );
    }
    if (text !== '' && SENSITIVE_PATH.test(text)) {
      raise(
        'p2',
        { code: 'outside-workspace', detail: `${file.relativePath} 提到了工作空间外的敏感路径。` },
        '它可以读到工作空间之外的目录（例如密钥或系统配置）。',
      );
    }

    if (/\.(py|mjs|js|sh)$/.test(lower) || SHELL_HINT.test(text)) {
      raise('p1', {
        code: 'commands',
        detail: `${file.relativePath} 会执行命令或脚本。`,
      });
    }
    if (text !== '' && LIMITED_NET.test(text) && level !== 'p2') {
      raise('p1', {
        code: 'limited-network',
        detail: `${file.relativePath} 声明了有限网络访问。`,
      });
    }
  }

  if (level === 'p2' && worst === undefined) {
    worst = '它声明的能力面超出了工作空间内的读写。';
  }

  return {
    level,
    findings,
    ...(worst !== undefined ? { worstCase: worst } : {}),
  };
}

function rank(level: RiskLevel): number {
  if (level === 'p0') return 0;
  if (level === 'p1') return 1;
  return 2;
}

export function riskLabel(level: RiskLevel): string {
  if (level === 'p0') return '低风险';
  if (level === 'p1') return '需注意';
  return '高风险';
}

export function sourceLabel(source: 'official' | 'private' | 'local' | 'git'): string {
  if (source === 'official') return '官方内置';
  if (source === 'private') return '企业私有源';
  if (source === 'git') return 'Git';
  return '本地目录';
}
