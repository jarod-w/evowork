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

/**
 * 「删除」这条的理由。**同一句话也是内核 prompt 规则的 justification**（见 `KERNEL_PROMPT_RULES`），
 * `commandApprovalRationale` 靠它认出"这是我们自己那条规则问的"。两处写两遍会慢慢不一样，
 * 那时审批卡就会露出内核的英文包装。
 */
export const DELETE_REASON = '这个命令会删除文件';

/**
 * 内核补丁 P6（`patches/evowork/0001-exec-overwrite-approval`）给「覆盖已有文件」的审批理由前缀。
 * 是**我们自己补丁里的**字符串，所以可以认；`services/policy/test` 有一条断言补丁里的前缀与这里逐字相同。
 */
export const OVERWRITE_REASON_PREFIX = 'overwrites an existing file: ';

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
    reason: DELETE_REASON,
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

/**
 * 审批卡上「为什么需要确认」与「影响范围」（10 §3.2，**必填**）。
 *
 * 内核给的 `reason` 有三种来源，只有一种是给人看的：
 *
 * - 模型为越过沙箱写的 `justification` —— 它说的是**用途**，原样保留；
 * - 我们自己那几条 prompt 规则 —— 内核会包一层英文（`` `rm x` requires approval: … ``），
 *   认出来之后换成我们的中文，**不去匹配内核的英文原文**（上游改个词就会静默失效），
 *   只看里面有没有我们自己写的那句理由；
 * - 内核的危险命令启发式（`rm -f` 之类）—— **不给理由**。2026-09-28 外部测试的 A1 / D1-3
 *   两张卡都因此写着「执行内核没有给出理由 —— 这本身值得警惕，建议先拒绝」，
 *   而那只是一次普通的删临时文件。没有理由时由这里的命令判定补上。
 */
export function commandApprovalRationale(
  command: string,
  kernelReason: string | undefined,
): {
  readonly reason: string;
  readonly impact: string;
  readonly dimensions: readonly RiskDimension[];
} {
  const risk = analyzeCommand(command);
  const kernel = kernelReason?.trim();
  if (kernel?.startsWith(OVERWRITE_REASON_PREFIX.trim())) {
    const targets = kernel.slice(OVERWRITE_REASON_PREFIX.trim().length).trim();
    return {
      reason: `这个命令会覆盖已有的文件（${targets}），原来的内容找不回来`,
      impact: risk.impact,
      dimensions: risk.dimensions,
    };
  }
  const ours = kernel !== undefined && MATCHERS.some((matcher) => kernel.includes(matcher.reason));
  return {
    reason: kernel === undefined || kernel === '' || ours ? risk.reason : kernel,
    impact: risk.impact,
    dimensions: risk.dimensions,
  };
}

/**
 * 装进 `$CODEX_HOME/rules/evowork.rules` 的内核 execpolicy 规则（Q45 修订，2026-09-28）。
 *
 * 内核的危险命令启发式只认**带 -f 的 rm**（`shell-command/src/command_safety/is_dangerous_command.rs`），
 * 于是在「请求批准」档里 `rm -f x` 会问、`rm x` 不问 —— 2026-09-28 外部测试 D1-1 / D1-4 就是这样
 * 删掉了文件。这几条 prompt 规则把**纯删除命令**补进审批。
 *
 * **只是部分覆盖**，这一点必须如实写着：内核只对「不含重定向、子 shell 等语法的纯命令序列」
 * 按段匹配规则（`shell-command/src/bash.rs` 的 `parse_shell_lc_plain_commands`）。
 * `printf … > 已有文件`（覆盖，D1-2）、以及任何含 `>` / `>>` 的组合脚本（D1-4 的原样命令）
 * 都匹配不上 —— 扩展点做不到，完整覆盖只能走内核补丁（K1）。
 */
export const KERNEL_PROMPT_RULES = `# 由 EvoWork 生成，每次启动重写 —— 改这里不会留下来，改 services/policy/src/execpolicy.ts。
# 删除类命令在工作空间内也要问（Q45 修订，10 §2.4）。
prefix_rule(pattern = ["rm"], decision = "prompt", justification = ${JSON.stringify(DELETE_REASON)})
prefix_rule(pattern = ["rmdir"], decision = "prompt", justification = ${JSON.stringify(DELETE_REASON)})
prefix_rule(pattern = ["unlink"], decision = "prompt", justification = ${JSON.stringify(DELETE_REASON)})
`;
