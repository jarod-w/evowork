/**
 * 本机安全能力与平台差异（10 §7，Q6 / Q26 / R8）。
 *
 * ## 这个文件为什么存在
 *
 * 10 §7 的要求不是"支持 Windows"，而是**"平台差异必须显式告知而不是静默不同"**：
 * 设置里有一页「本机安全能力」，列出当前平台的沙箱类型、可用隔离级别、
 * 以及因此受限的功能。用户在不同平台看到不同行为时，能找到解释。
 *
 * ## Windows 的结论还没拿到
 *
 * Q6 决定暂用上游 `windows-sandbox-rs` 不自研，隔离强度在 M4 单独评估。
 * **那次评估需要一台 Windows 机器，本轮拿不到**（与 U1/U3/U4 同类）。
 * 所以这里把两种结论的行为都实现好，由 `WindowsIsolationVerdict` 选择 ——
 * 而当前值是 `'unknown'`，它的行为**与"不足"一致**（保守侧），
 * 并在能力页上如实说"还没评估"。
 *
 * 保守默认是刻意的：如果默认按"足够"走，评估一旦得出"不足"，
 * 中间这段时间里 Windows 用户是在一个我们以为安全、实际未知的环境里跑 full access。
 */

export type Platform = 'darwin' | 'win32' | 'linux';

export type SandboxKind = 'seatbelt' | 'landlock-seccomp' | 'windows-sandbox' | 'none';

/** Windows 隔离强度的评估结论（M4 的产出）。 */
export type WindowsIsolationVerdict = 'sufficient' | 'insufficient' | 'unknown';

/**
 * 当前的结论。**`unknown` 是如实的状态**，不是占位符。
 * 拿到评估结果后改这里 —— 并同时更新 `docs/status.md` 的第 3 节。
 */
export const WINDOWS_ISOLATION: WindowsIsolationVerdict = 'unknown';

export interface SecurityCapability {
  readonly platform: Platform;
  readonly sandbox: SandboxKind;
  /** 能不能用 `evowork-full` */
  readonly fullAccessAllowed: boolean;
  /** 停用时的原因。UI 直接显示（Q26：给原因页，不静默降级） */
  readonly fullAccessDisabledReason?: string;
  /** 能力页上列出的说明 */
  readonly notes: readonly string[];
}

export function describeCapability(
  platform: Platform,
  verdict: WindowsIsolationVerdict = WINDOWS_ISOLATION,
): SecurityCapability {
  if (platform === 'darwin') {
    return {
      platform,
      sandbox: 'seatbelt',
      fullAccessAllowed: true,
      notes: [
        '使用 macOS 的 Seatbelt 沙箱：文件与网络访问按 profile 限制。',
        '敏感目录的硬拦截对所有权限档位生效，包括完全访问。',
      ],
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      sandbox: 'landlock-seccomp',
      fullAccessAllowed: true,
      notes: [
        '使用 Landlock + seccomp：文件与系统调用按 profile 限制。',
        '内核版本过低时 Landlock 不可用，此时会退回到以审批为主的模式。',
      ],
    };
  }

  // Windows：两种结论的行为都在这里，由 verdict 选择
  if (verdict === 'sufficient') {
    return {
      platform,
      sandbox: 'windows-sandbox',
      fullAccessAllowed: true,
      notes: ['使用 Windows 沙箱组件，隔离强度已评估为可用，行为与 macOS / Linux 一致。'],
    };
  }
  const reason =
    verdict === 'insufficient'
      ? '当前系统的隔离能力有限，已停用完全访问'
      : '这台机器上的隔离强度还没有评估结论，出于谨慎已暂时停用完全访问';
  return {
    platform,
    sandbox: 'windows-sandbox',
    fullAccessAllowed: false,
    fullAccessDisabledReason: reason,
    notes: [
      reason + '。',
      '其余档位（只读 / 只读+联网 / 默认权限）可以正常使用。',
      '这台机器上的审批会更细：需要写文件或联网的动作都会逐次询问你。',
      ...(verdict === 'unknown' ? ['评估完成后这一页会更新，届时完全访问可能恢复可用。'] : []),
    ],
  };
}

/**
 * 隔离不足时审批策略要**提升**而不是放松（R8 原话：以审批为主）。
 *
 * 返回的是"这个平台上默认的审批策略"，交给适配层去传 `turn/start`。
 */
export function approvalPolicyFor(
  capability: SecurityCapability,
): 'on-request' | 'on-failure' | 'untrusted' {
  return capability.fullAccessAllowed ? 'on-request' : 'untrusted';
}

/** 首运行时 Windows 沙箱组件可跳过；跳过则只剩只读与审批模式（10 §7 最后一段）。 */
export const WINDOWS_SANDBOX_SKIP_NOTICE =
  '跳过安装隔离组件后，这台机器上只能使用只读模式，以及需要你逐次确认的操作。随时可以在「设置 → 本机安全能力」里补装。';
