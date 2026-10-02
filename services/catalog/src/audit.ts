/**
 * 安装时静态审计（05 §3.3）。
 *
 * **不执行**被审计目录里的任何代码。判定只看文件名与文本内容。
 * 缺文件列表时按最严（P2）—— 读不到就等于能力面未知。
 */
import type { AuditFinding, AuditResult, RiskLevel } from './types.js';

/**
 * 审计规则的版本（13 §4.1 `audit.rulesVersion`、§5.3）。**改了下面任何一条判定就要改它。**
 *
 * Hub 的 CI 和用户手里的 App 用的是两个仓库各自发版的规则（HUB-Q9=A），客户端本地再审一遍时：
 * 版本相同，结论必须一致（不一致 = 内容或索引被动过，拒装）；版本不同，取两边更严的那个。
 * 改了规则却没改版本号，前一条就会把正常的包判成「被动过」。
 */
export const AUDIT_RULES_VERSION = '2026-10-02.2';

const P2_BIN_EXT = ['.exe', '.dll', '.so', '.dylib', '.bin', '.wasm'];
const SENSITIVE_PATH = /(?:^|[^\w.])(?:\/etc\/|\/root\/|~\/\.ssh|~\.ssh|\.ssh\/|\/proc\/)/i;
const ARBITRARY_NET =
  /(?:network\s*[:=]\s*(?:any|\*)|danger-full-access|allow_all_unix|permissions\s*[:=]\s*["']?\*)/i;
const LIMITED_NET = /(?:https?:\/\/[^\s]+|network_access|mcp_servers?)/i;
const SHELL_HINT = /(?:\b(bash|sh|zsh|powershell|cmd\.exe|os\.system|subprocess)\b)/i;

/*
 * 指令文本规则（13 §7.1 G3，2026-10-02.2）。ClawHavoc 那批恶意技能很多**没有脚本**，
 * 只在 SKILL.md 的「前置条件」里诱导用户或模型去装东西 —— 只审脚本不够，指令文本也要审。
 *
 * 判据刻意收窄到「几乎没有正当用途」的写法，避免把正常的 `pip install requests` 也判成诱导：
 * 管道见到 `lure` 是直接拒收的。
 */
/** 下载即执行：`curl … | sh`、`wget -O- … | bash`、`iwr … | iex`、`base64 -d | sh`。 */
const PIPE_TO_SHELL =
  /(?:\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b|base64\s+(?:-d|--decode)[^\n|]*\|\s*(?:ba|z)?sh\b)/i;
/** 让人去下载一个可执行文件，或者去掉系统的隔离标记、把命令粘进终端（ClickFix）。 */
const INSTALL_LURE =
  /(?:https?:\/\/[^\s)'"]+\.(?:exe|msi|dmg|pkg|command|scr|bat|ps1)(?:[\s)'"?#]|$)|xattr\s+-[a-z]*d[a-z]*\s+com\.apple\.quarantine|(?:paste|copy)\s+(?:this|the following|it)\s+(?:command\s+)?(?:into|in)\s+(?:your\s+)?(?:terminal|powershell|the run dialog|cmd)|(?:粘贴|复制)到(?:你的)?(?:终端|命令行|运行窗口|PowerShell))/i;
/** 大段 base64：藏东西最常见的办法。 */
const BASE64_BLOB = /[A-Za-z0-9+/]{400,}={0,2}/;
/** 收数据用的公共端点：webhook、粘贴站、内网穿透。 */
const EXFIL_HOST =
  /\b(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|pastebin\.com|hastebin\.com|paste\.ee|transfer\.sh|ngrok(?:-free)?\.(?:io|app)|discord(?:app)?\.com\/api\/webhooks)\b/i;
/** 凭据：钥匙串、云账号凭据文件、私钥文件。 */
const CREDENTIAL_PATH =
  /(?:security\s+(?:find|dump)-(?:generic|internet)-password|\bdump-keychain\b|login\.keychain|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\bid_(?:rsa|ed25519|ecdsa)\b)/i;

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
    if (text !== '' && PIPE_TO_SHELL.test(text)) {
      raise(
        'p2',
        {
          code: 'pipe-to-shell',
          detail: `${file.relativePath} 让人把下载下来的内容直接交给 shell 执行。`,
          lure: true,
        },
        '它会从网上下载一段没人检查过的程序并立刻运行，能做你在这台电脑上能做的任何事。',
      );
    }
    if (text !== '' && INSTALL_LURE.test(text)) {
      raise(
        'p2',
        {
          code: 'install-lure',
          detail: `${file.relativePath} 引导下载可执行文件、去掉系统隔离标记，或把命令粘进终端。`,
          lure: true,
        },
        '这是诱导安装恶意程序的常见写法：装上的东西不受任何检查。',
      );
    }
    if (text !== '' && BASE64_BLOB.test(text)) {
      raise(
        'p2',
        {
          code: 'base64-blob',
          detail: `${file.relativePath} 里有一大段 base64，内容无法直接审阅。`,
        },
        '大段编码内容可能藏着任何东西，静态审计看不穿它。',
      );
    }
    if (text !== '' && EXFIL_HOST.test(text)) {
      raise(
        'p2',
        {
          code: 'exfil-host',
          detail: `${file.relativePath} 提到了 webhook / 粘贴站 / 内网穿透这类收数据的地址。`,
        },
        '它可能把你的文件或对话内容发到第三方收集端点。',
      );
    }
    if (text !== '' && CREDENTIAL_PATH.test(text)) {
      raise(
        'p2',
        {
          code: 'credentials',
          detail: `${file.relativePath} 会接触钥匙串、云账号凭据或私钥文件。`,
        },
        '它可以读到你的登录凭据与密钥。',
      );
    }
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
    if (text !== '' && LIMITED_NET.test(text) && rank(level) < 2) {
      raise('p1', {
        code: 'limited-network',
        detail: `${file.relativePath} 声明了有限网络访问。`,
      });
    }
  }

  if (rank(level) >= 2 && worst === undefined) {
    worst = '它声明的能力面超出了工作空间内的读写。';
  }

  return {
    level,
    findings,
    ...(worst !== undefined ? { worstCase: worst } : {}),
  };
}

/**
 * 能力面（13 §5.4 判「更新是否扩大了能力」用）：要访问的域名、会执行的脚本、有没有 hooks。
 *
 * 和 `auditSkillFiles` 看的是同一批文件；它给等级，这里给清单。两者一起才能判「等级没升，
 * 但多了一个域名」这种情况。
 */
export interface Capabilities {
  readonly network: readonly string[];
  readonly commands: readonly string[];
  readonly hooks: boolean;
}

const URL_RE = /https?:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)/g;

export function extractCapabilities(files: readonly AuditFile[]): Capabilities {
  const network = new Set<string>();
  const commands = new Set<string>();
  let hooks = false;
  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    const base = lower.split(/[/\\]/).pop() ?? lower;
    if (base === 'hooks.json' || lower.includes('/hooks/') || lower.startsWith('hooks/'))
      hooks = true;
    if (/\.(py|mjs|js|cjs|sh|ps1|bat)$/.test(lower)) commands.add(file.relativePath);
    for (const m of (file.text ?? '').matchAll(URL_RE)) {
      if (m[1] !== undefined) network.add(m[1].toLowerCase());
    }
  }
  return {
    network: [...network].sort(),
    commands: [...commands].sort(),
    hooks,
  };
}

export function rankLevel(level: RiskLevel): number {
  return rank(level);
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

export function sourceLabel(source: 'official' | 'hub' | 'private' | 'local' | 'git'): string {
  if (source === 'official') return '官方内置';
  if (source === 'hub') return 'EvoWork 精选';
  if (source === 'private') return '企业私有源';
  if (source === 'git') return 'Git';
  return '本地目录';
}
