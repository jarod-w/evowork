/**
 * 权限 profile 的文案映射（10 §2.2）。
 *
 * 内核已经把权限模型做完了（F4：`permissionProfile/list` 返回 `{id, description, allowed}`，
 * 支持 `extends` 继承，`allowed:false` 就是"存在但你不能选"）。**不要自建一套权限模型** ——
 * 这里只做一件事：把 id 翻译成用户看得懂的中文。
 *
 * ## 三条规则（10 §2.2 原文）
 *
 * 1. 已知 id 用我们的文案；
 * 2. 未知 id（企业自定义）用协议返回的 `description`；
 * 3. 都没有就显示 id 本身 —— **不隐藏未知 profile**。
 *
 * 第 3 条是关键：企业加了一个自定义档位而我们不认识时，用户应该看到它并能选，
 * 而不是"这个档位在 EvoWork 里消失了"。
 */

export interface ProfileCopy {
  readonly name: string;
  /** 一句话说明，UI 直接显示 */
  readonly summary: string;
  /** 选中它需要二次确认（10 §2.2 的 evowork-full） */
  readonly requiresConfirmation?: boolean;
}

export const PROFILE_COPY: Readonly<Record<string, ProfileCopy>> = Object.freeze({
  'evowork-ask': { name: '只读', summary: '只能查看文件，不能修改，也不联网' },
  'evowork-plan': { name: '只读 + 联网', summary: '可以查看文件和上网查资料，不能修改文件' },
  'evowork-workspace': {
    // 直接对应截图 1 的「默认权限 ∨」——不需要发明新控件（03 §4.5）
    name: '默认权限',
    summary: '可以在这个工作空间里读写文件、执行命令',
  },
  'evowork-full': {
    name: '完全访问',
    summary: '可以读写这台电脑上的任何文件并联网',
    requiresConfirmation: true,
  },
  // 内置档位也给文案：用户可能在企业配置里直接看到它们
  ':read-only': { name: '只读', summary: '只能查看，不能修改' },
  ':workspace': { name: '工作空间可写', summary: '可以在工作空间里读写与执行' },
  ':danger-full-access': {
    name: '完全访问',
    summary: '不受限制地读写与联网',
    requiresConfirmation: true,
  },
});

/** `permissionProfile/list` 返回的形状（F4）。 */
export interface ProtocolProfile {
  readonly id: string;
  readonly description?: string | undefined;
  readonly allowed: boolean;
}

export interface ProfileOption {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly allowed: boolean;
  readonly requiresConfirmation: boolean;
  /** `allowed:false` 时的原因。UI 必须显示它（10 §2.1 / 01 §6.3） */
  readonly disabledReason?: string;
}

export function toProfileOptions(
  profiles: readonly ProtocolProfile[],
  /** 企业策略给的停用原因；缺省时给一句通用的 */
  disabledReasonOf?: (id: string) => string | undefined,
): readonly ProfileOption[] {
  return profiles.map((profile) => {
    const copy = PROFILE_COPY[profile.id];
    const name = copy?.name ?? profile.id;
    const summary = copy?.summary ?? profile.description ?? '';
    const option: ProfileOption = {
      id: profile.id,
      name,
      summary,
      allowed: profile.allowed,
      requiresConfirmation: copy?.requiresConfirmation ?? false,
      ...(profile.allowed
        ? {}
        : { disabledReason: disabledReasonOf?.(profile.id) ?? '已被企业策略锁定' }),
    };
    return option;
  });
}

/** 工作模式 → 默认 profile（D8：Ask = 只读沙箱，不新增 ModeKind 枚举）。 */
export const MODE_PROFILE: Readonly<Record<'craft' | 'plan' | 'ask', string>> = Object.freeze({
  craft: 'evowork-workspace',
  plan: 'evowork-plan',
  ask: 'evowork-ask',
});

/**
 * Windows 隔离不足时把 `evowork-full` 停用（Q26 / 10 §7）。
 *
 * **给原因页而不是静默降级**（Q26 原话）：返回的是带 `disabledReason` 的选项，
 * 不是把这一项从列表里删掉。用户需要知道"存在这一档但在这台机器上不能用"。
 */
export function applyPlatformRestriction(
  options: readonly ProfileOption[],
  restriction: { readonly disableFullAccess: boolean; readonly reason: string },
): readonly ProfileOption[] {
  if (!restriction.disableFullAccess) return options;
  return options.map((option) =>
    option.id === 'evowork-full' || option.id === ':danger-full-access'
      ? { ...option, allowed: false, disabledReason: restriction.reason }
      : option,
  );
}
