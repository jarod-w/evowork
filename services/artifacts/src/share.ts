/**
 * 分享（Q10 的完整流程，08 §7）。
 *
 * ## 这是本机内容离开设备的**唯一常规出网路径**（除模型调用）
 *
 * 所以流程刻意做得重：每次都过授权模态、不记住选择、不做批量、可撤销、到期自动删。
 *
 * ## 六条硬规则里最容易被"优化"掉的两条
 *
 * 1. **不记住授权**。"逐次授权"是 Q10 的原话。做一个"以后不再询问"的勾选框
 *    会让这条通道在用户第二次点分享之后就变成默认开启。
 * 2. **不做批量分享**。批量会让用户一次性上传比他想象中更多的东西 ——
 *    而"上传了什么"正是这个流程唯一要让用户想清楚的事。
 */

export type ShareTtl = '24h' | '7d' | '30d';

export const TTL_MS: Readonly<Record<ShareTtl, number>> = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

export const DEFAULT_TTL: ShareTtl = '24h';

/** 到期前多久通知一次（08 §7.2 规则 4）。 */
export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export interface ShareAuthorization {
  /** 要上传的东西。**一次一个**（规则 2：不做批量） */
  readonly artifactId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly artifactTypeLabel: string;
  readonly ttl: ShareTtl;
  readonly password?: string | undefined;
  /** 「我确认这份文件可以对外分享」。**不预勾**（08 §7.1） */
  readonly confirmed: boolean;
}

export type ShareRefusal =
  | { readonly code: 'NOT_CONFIRMED'; readonly message: string }
  | { readonly code: 'DISABLED_BY_POLICY'; readonly message: string }
  | { readonly code: 'FILE_MISSING'; readonly message: string };

export interface ShareContext {
  /** 企业策略可全局禁用分享（R11 / 08 §7.2 规则 6） */
  readonly sharingEnabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly fileExists: boolean;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface ShareRecord {
  readonly id: string;
  readonly artifactId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hasPassword: boolean;
  readonly revokedAt?: number | undefined;
  readonly accessCount: number;
}

/**
 * 授权模态要显示的东西（08 §7.1）。
 *
 * 三句话缺一不可：**上传什么**、**上传到哪+谁能看**、**多久失效**。
 * 少了第二句，用户以为分享是本机链接；少了第三句，他以为链接是永久的。
 */
export function authorizationSummary(input: {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly artifactTypeLabel: string;
  readonly ttl: ShareTtl;
}): readonly string[] {
  const mb = (input.sizeBytes / 1024 / 1024).toFixed(1);
  return [
    `将要上传：${input.fileName}（${input.artifactTypeLabel}，${mb} MB）`,
    '文件会上传到 EvoWork 云。**任何拿到链接的人都能访问它。**',
    `链接在 ${TTL_LABEL[input.ttl]}后失效，之后云端副本会被自动删除。`,
  ];
}

export const TTL_LABEL: Readonly<Record<ShareTtl, string>> = Object.freeze({
  '24h': '24 小时',
  '7d': '7 天',
  '30d': '30 天',
});

export function createShare(
  authorization: ShareAuthorization,
  context: ShareContext,
):
  | { readonly ok: true; readonly share: ShareRecord }
  | { readonly ok: false; readonly refusal: ShareRefusal } {
  if (!context.sharingEnabled) {
    return {
      ok: false,
      refusal: {
        code: 'DISABLED_BY_POLICY',
        // 01 §6.3：禁用必须给原因
        message: context.disabledReason ?? '你所在的组织已停用分享功能。',
      },
    };
  }
  if (!context.fileExists) {
    return {
      ok: false,
      refusal: { code: 'FILE_MISSING', message: '这个文件已经不在磁盘上了，没法分享。' },
    };
  }
  if (!authorization.confirmed) {
    // 勾选框不预勾，所以"没勾"是默认状态，不是用户失误 —— 文案不要责备
    return {
      ok: false,
      refusal: {
        code: 'NOT_CONFIRMED',
        message: '请先确认这份文件可以对外分享。',
      },
    };
  }

  const createdAt = context.now();
  return {
    ok: true,
    share: {
      id: context.newId(),
      artifactId: authorization.artifactId,
      createdAt,
      expiresAt: createdAt + TTL_MS[authorization.ttl],
      hasPassword: (authorization.password ?? '') !== '',
      accessCount: 0,
    },
  };
}

export type ShareState = 'active' | 'expiring-soon' | 'expired' | 'revoked';

export function shareState(share: ShareRecord, now: number): ShareState {
  if (share.revokedAt !== undefined) return 'revoked';
  if (now >= share.expiresAt) return 'expired';
  if (share.expiresAt - now <= EXPIRY_WARNING_MS) return 'expiring-soon';
  return 'active';
}

/** 撤销即云端删除 + 链接失效（规则 3）。 */
export function revoke(share: ShareRecord, now: number): ShareRecord {
  return { ...share, revokedAt: now };
}

/**
 * 分享**任务**（清单 §4.4）走同一模态，但要额外警告并**提供预览**（08 §7.2 规则 5）。
 *
 * 「不许盲传」是这条的关键：任务对话里可能有工作空间路径、文件内容片段与业务信息，
 * 而用户对"分享一个任务"的直觉是"分享一段对话"，想不到这些。
 */
export const THREAD_SHARE_WARNING =
  '任务里可能包含工作空间路径、文件内容片段与业务信息。上传前请先预览将要分享的内容。';

export function requiresContentPreview(target: 'artifact' | 'thread'): boolean {
  return target === 'thread';
}

/**
 * 「另存为」到本机任意位置（含用户自己挂载的网盘目录）。
 *
 * 这是清单 §6.3「上传到云端网盘」在 v1 的等价能力（Q9 本期不做那些集成）——
 * 而且它**不经过我们的云**，反而更符合 K6。分享面板里不出现那些第三方目标，也不做占位。
 */
export const LOCAL_SAVE_HINT =
  '另存到本机任意位置（包括你自己挂载的网盘目录），不经过 EvoWork 云。';
