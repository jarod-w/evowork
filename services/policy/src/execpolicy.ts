/**
 * 命令风险判定（10 §3.2 的「为什么需要确认」与「影响范围」）。
 *
 * ## 它为什么必须存在
 *
 * 10 §3.2：**「为什么需要确认」是必填的** —— 没有理由的审批等于让用户瞎点。
 * 内核的 `execpolicy` 判定的是"允不允许"，而这里要的是"**为什么要问你**"，
 * 那是一句人话，得由我们来造。
 *
 * ## 四个维度（10 §3.2 的「影响范围」）
 *
 * 写盘 · 联网 · 删除 · 提权。分开列而不是给一个"危险等级"，是因为用户的判断依据不同：
 * 一个联网安装依赖的命令和一个删文件的命令都"中危"，但该不该允许完全是两回事。
 */

export type RiskDimension = 'writes-disk' | 'network' | 'deletes' | 'privilege';

export interface CommandRisk {
  readonly dimensions: readonly RiskDimension[];
  /** 「为什么需要确认」。**必填** */
  readonly reason: string;
  /** 「影响范围」的一句话 */
  readonly impact: string;
  /** 命中的规则名，进审计 */
  readonly rule: string;
}

export const DIMENSION_COPY: Readonly<Record<RiskDimension, string>> = Object.freeze({
  'writes-disk': '写入文件',
  network: '需要联网',
  deletes: '删除文件',
  privilege: '提升权限',
});

interface Matcher {
  readonly rule: string;
  readonly test: RegExp;
  readonly dimensions: readonly RiskDimension[];
  readonly reason: string;
}

/**
 * 判定用正则而不是解析 shell。
 *
 * 解析 shell 听起来更严谨，但 `sh -c` 里可以有任意嵌套、变量展开与拼接 ——
 * 一个"看起来解析对了"的实现会给出**虚假的安全感**。这里明确只做启发式判定，
 * 用途是**给用户一句解释**，而不是充当安全边界。真正的边界是沙箱与路径策略。
 * 这一点写在这里，免得以后有人把它当成 allowlist 来用。
 */
const MATCHERS: readonly Matcher[] = Object.freeze([
  {
    rule: 'privilege-escalation',
    test: /\b(sudo|doas|su)\b|\bchmod\s+(\+s|4755|u\+s)/,
    dimensions: ['privilege'],
    reason: '这个命令会以更高权限运行',
  },
  {
    rule: 'recursive-delete',
    test: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b|\bRemove-Item\b.*-Recurse/,
    dimensions: ['deletes', 'writes-disk'],
    reason: '这个命令会递归删除文件，删掉的东西找不回来',
  },
  {
    rule: 'delete',
    test: /\b(rm|unlink|rmdir|del)\b/,
    dimensions: ['deletes', 'writes-disk'],
    reason: '这个命令会删除文件',
  },
  {
    rule: 'package-install',
    test: /\b(pip3?|npm|pnpm|yarn|cargo|go|brew|apt|apt-get|gem)\s+(install|add|get)\b/,
    dimensions: ['network', 'writes-disk'],
    reason: '这个命令会从网络安装软件包',
  },
  {
    rule: 'network-fetch',
    test: /\b(curl|wget|nc|ncat|ssh|scp|rsync|git\s+(clone|push|pull|fetch))\b/,
    dimensions: ['network'],
    reason: '这个命令会访问网络',
  },
  {
    rule: 'pipe-to-shell',
    test: /\|\s*(sudo\s+)?(ba)?sh\b|\|\s*python3?\b/,
    dimensions: ['network', 'privilege', 'writes-disk'],
    reason: '这个命令会把下载到的内容直接当脚本执行 —— 内容变了它就变了',
  },
  {
    rule: 'redirect-write',
    test: /(^|[^>])>{1,2}[^>]/,
    dimensions: ['writes-disk'],
    reason: '这个命令会把输出写进文件',
  },
]);

/** 只读且众所周知的命令，不需要理由（它们进不了审批流）。 */
const OBVIOUSLY_READ_ONLY =
  /^\s*(ls|pwd|cat|head|tail|wc|grep|rg|fd|find|echo|which|file|stat|du|df|date)\b/;

export function analyzeCommand(command: string): CommandRisk {
  const hits = MATCHERS.filter((matcher) => matcher.test.test(command));

  if (hits.length === 0) {
    if (OBVIOUSLY_READ_ONLY.test(command)) {
      return {
        dimensions: [],
        rule: 'read-only',
        reason: '这个命令只读取信息，不改动任何东西',
        impact: '只读',
      };
    }
    // 认不出来时**不说"安全"** —— 说不清就说说不清，比编一个理由好
    return {
      dimensions: ['writes-disk'],
      rule: 'unknown',
      reason: '这个命令我判断不出它会做什么，所以问你一次',
      impact: '影响范围未知',
    };
  }

  const dimensions = [...new Set(hits.flatMap((hit) => hit.dimensions))];
  return {
    dimensions,
    rule: hits.map((hit) => hit.rule).join('+'),
    // 多条命中时把理由都给出来，而不是只报第一条 —— 用户要看的是全部风险
    reason: hits.map((hit) => hit.reason).join('；'),
    impact: dimensions.map((d) => DIMENSION_COPY[d]).join('、'),
  };
}

/**
 * 「本次任务内都允许」给不给（10 §3.3）。
 *
 * 只在**单文件、工作空间内、非删除**时提供。一次点击放开整个会话的写权限风险过高，
 * 而这三个条件恰好把"批量""越界""不可逆"三种最贵的错误挡在外面。
 */
export function allowAcceptForSession(input: {
  readonly fileCount: number;
  readonly anyOutsideWorkspace: boolean;
  readonly anyDelete: boolean;
}): boolean {
  return input.fileCount <= 1 && !input.anyOutsideWorkspace && !input.anyDelete;
}

/** 命令超长时**只截尾部，绝不省略中间**（10 §3.2：中间是注入的最佳藏身处）。 */
export function truncateCommand(command: string, limit = 200): string {
  return command.length <= limit ? command : `${command.slice(0, limit - 1)}…`;
}
