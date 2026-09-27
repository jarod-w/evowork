/**
 * 分享的**整条流程**（08 §7.1 的四步），把一直各自躺着的两块接起来：
 * `share.ts` 的授权判定与 `upload.ts` 的上传。
 *
 * 这两个模块写好很久，**从来没有调用方**（status.md §6.1 的 D 项）——
 * 于是"分享按钮背后没有链路"，连授权对话框都到不了。这个文件就是那个调用方。
 *
 * ## 顺序是硬的：授权 → 读文件 → 上传
 *
 * `createShare` 通过之前**一个字节都不读**（`upload.ts` 头注释的第 1 条）。
 * 顺序反了的话，"用户取消了授权"与"文件已经被读进内存"会同时成立。
 *
 * ## 链接里带文件名片段
 *
 * 云端不知道文件名（08 §7.5），接收方看到的名字来自 `#` 之后那一段。
 * 所以**能复制的那条链接是在这里拼出来的**，不是服务端返回的那条裸 url。
 */
import { extname } from 'node:path';

import type { Logger } from '@evowork/logging';

import {
  authorizationSummary,
  createShare,
  TTL_LABEL,
  TTL_MS,
  type ShareRefusal,
  type ShareTtl,
} from './share.js';
import { hashShareAccessCode, type UploadResult } from './upload.js';

/** 扩展名 → MIME。认不出就交给服务端按 `application/octet-stream` 处理。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
};

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface ShareTarget {
  readonly artifactId: string;
  readonly path: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly artifactTypeLabel: string;
}

/** 授权模态要显示的东西（08 §7.1）。 */
export interface SharePlan {
  readonly artifactId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly artifactTypeLabel: string;
  /** 三句话：上传什么 · 上传到哪+谁能看 · 多久失效。缺一不可 */
  readonly summary: readonly string[];
  readonly ttl: ShareTtl;
  readonly ttlOptions: readonly { readonly id: ShareTtl; readonly label: string }[];
}

export interface ShareFlowPorts {
  /** 企业策略可全局禁用分享（R11 / 08 §7.2 规则 6）。 */
  readonly policy: () => { readonly enabled: boolean; readonly reason?: string | undefined };
  readonly findTarget: (artifactId: string) => ShareTarget | undefined;
  readonly fileExists: (path: string) => boolean;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly uploader: () =>
    | {
        upload(
          input: {
            shareId: string;
            fileName: string;
            bytes: Uint8Array;
            contentType: string;
            expiresAt: number;
            accessCodeHash?: string | undefined;
          },
          options?: { signal?: AbortSignal | undefined },
        ): Promise<UploadResult>;
        revoke(shareId: string): Promise<boolean>;
      }
    | undefined;
  readonly persist: (row: {
    id: string;
    /** 分享产物时给它；分享任务时给 `threadId` —— 两者互斥 */
    artifactId?: string | undefined;
    threadId?: string | undefined;
    url: string;
    expiresAt: number;
    hasPassword: boolean;
    createdAt: number;
  }) => void;
  readonly attachShare: (artifactId: string, shareId: string | null) => void;
  readonly markRevoked: (shareId: string, at: number) => void;
  readonly findShare: (shareId: string) => { readonly id: string } | undefined;
  readonly now: () => number;
  readonly newId: () => string;
  readonly logger?: Logger | undefined;
}

export type ShareOutcome =
  | {
      readonly ok: true;
      readonly shareId: string;
      readonly url: string;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly refused: string; readonly code: string };

/**
 * 把服务端回来的裸链接拼成**能发给别人的那一条**。
 *
 * `#` 之后的内容浏览器不会发给服务器，所以文件名只在接收方那一侧出现（08 §7.5）。
 */
export function linkWithName(url: string, fileName: string): string {
  return `${url}#${encodeURIComponent(fileName)}`;
}

export function createShareFlow(ports: ShareFlowPorts) {
  /**
   * 第 ① 步：授权模态要的数据。
   *
   * **每次都要过这一步**，不记住选择（Q10 的原话）——
   * 所以这里不缓存，也没有"以后不再询问"的开关。
   */
  function plan(
    artifactId: string,
  ): SharePlan | { readonly refused: string; readonly code: string } {
    const policy = ports.policy();
    if (!policy.enabled) {
      return {
        code: 'DISABLED_BY_POLICY',
        refused: policy.reason ?? '你所在的组织已停用分享功能。',
      };
    }
    const target = ports.findTarget(artifactId);
    if (!target) return { code: 'FILE_MISSING', refused: '找不到这个产物。' };
    if (!ports.fileExists(target.path)) {
      return { code: 'FILE_MISSING', refused: '这个文件已经不在磁盘上了，没法分享。' };
    }
    const ttl: ShareTtl = '24h';
    return {
      artifactId,
      fileName: target.fileName,
      sizeBytes: target.sizeBytes,
      artifactTypeLabel: target.artifactTypeLabel,
      summary: authorizationSummary({
        fileName: target.fileName,
        sizeBytes: target.sizeBytes,
        artifactTypeLabel: target.artifactTypeLabel,
        ttl,
      }),
      ttl,
      ttlOptions: (Object.keys(TTL_MS) as ShareTtl[]).map((id) => ({ id, label: TTL_LABEL[id] })),
    };
  }

  /**
   * 分享**任务**（08 §7.2 规则 5）。
   *
   * 与分享产物走同一条上传路，但有两处不同，而两处都是规则 5 要的：
   *   1. 内容**由调用方给**（任务导出没有磁盘文件），所以这里不读盘；
   *   2. 调用方必须已经把这份内容给用户看过 —— `previewed` 是一个显式的入参，
   *      不是默认 true。**不许盲传**是这条规则的原话。
   *
   * 为什么内容从外面传进来而不是在这里生成：预览的字符串与上传的字符串必须
   * 是**同一个值**，不是两次各自的推导。分两处生成的话，某天一处改了另一处没改，
   * 预览就开始撒谎，而那正是这条规则要防的事。
   */
  async function performThread(
    input: {
      readonly threadId: string;
      readonly fileName: string;
      readonly markdown: string;
      readonly ttl: ShareTtl;
      readonly accessCode?: string | undefined;
      readonly confirmed: boolean;
      /** 用户确实看过将要上传的内容（不许盲传）。 */
      readonly previewed: boolean;
    },
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<ShareOutcome> {
    if (!input.previewed) {
      return {
        ok: false,
        code: 'NOT_PREVIEWED',
        refused: '分享任务前要先看一遍将要上传的内容。',
      };
    }
    const bytes = new TextEncoder().encode(input.markdown);
    const policy = ports.policy();
    const created = createShare(
      {
        artifactId: input.threadId,
        fileName: input.fileName,
        sizeBytes: bytes.byteLength,
        artifactTypeLabel: '任务记录',
        ttl: input.ttl,
        ...(input.accessCode ? { accessCode: input.accessCode } : {}),
        confirmed: input.confirmed,
      },
      {
        sharingEnabled: policy.enabled,
        ...(policy.reason ? { disabledReason: policy.reason } : {}),
        // 任务导出不在磁盘上，这一关对它恒真
        fileExists: true,
        now: ports.now,
        newId: () => `shr_${ports.newId()}`,
      },
    );
    if (!created.ok) return refuse(created.refusal);

    const uploader = ports.uploader();
    if (!uploader) {
      return {
        ok: false,
        code: 'NOT_SIGNED_IN',
        refused: '分享要先登录 —— 链接托管在 EvoWork 云上。你也可以用「另存为」把文件发给对方。',
      };
    }

    const share = created.share;
    const result = await uploader.upload(
      {
        shareId: share.id,
        fileName: input.fileName,
        bytes,
        contentType: 'text/markdown',
        expiresAt: share.expiresAt,
        ...(input.accessCode
          ? { accessCodeHash: hashShareAccessCode(input.accessCode, share.id) }
          : {}),
      },
      options,
    );
    if (!result.ok) {
      ports.logger?.warn('share.flow.failed', { shareId: share.id, reason: result.code });
      return { ok: false, code: result.code, refused: result.message };
    }

    const url = linkWithName(result.url, input.fileName);
    ports.persist({
      id: share.id,
      // 任务分享不挂产物：它的来源是 thread，不是 artifact
      threadId: input.threadId,
      url,
      expiresAt: share.expiresAt,
      hasPassword: share.hasPassword,
      createdAt: share.createdAt,
    });
    ports.logger?.info('share.flow.succeeded', { shareId: share.id, byteSize: bytes.byteLength });
    return { ok: true, shareId: share.id, url, expiresAt: share.expiresAt };
  }

  /** 第 ②③④ 步：上传 · 拿链接 · 落库。 */
  async function perform(
    input: {
      readonly artifactId: string;
      readonly ttl: ShareTtl;
      readonly accessCode?: string | undefined;
      readonly confirmed: boolean;
    },
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<ShareOutcome> {
    const target = ports.findTarget(input.artifactId);
    if (!target) return refuse({ code: 'FILE_MISSING', message: '找不到这个产物。' });

    const policy = ports.policy();
    const created = createShare(
      {
        artifactId: input.artifactId,
        fileName: target.fileName,
        sizeBytes: target.sizeBytes,
        artifactTypeLabel: target.artifactTypeLabel,
        ttl: input.ttl,
        ...(input.accessCode ? { accessCode: input.accessCode } : {}),
        confirmed: input.confirmed,
      },
      {
        sharingEnabled: policy.enabled,
        ...(policy.reason ? { disabledReason: policy.reason } : {}),
        fileExists: ports.fileExists(target.path),
        now: ports.now,
        newId: () => `shr_${ports.newId()}`,
      },
    );
    if (!created.ok) return refuse(created.refusal);

    const uploader = ports.uploader();
    if (!uploader) {
      // 没登录就没有上传目标。**如实说**，不把它写成"稍后重试"
      return {
        ok: false,
        code: 'NOT_SIGNED_IN',
        refused: '分享要先登录 —— 链接托管在 EvoWork 云上。你也可以用「另存为」把文件发给对方。',
      };
    }

    // 授权通过之后**才**读文件（upload.ts 头注释第 1 条）
    const bytes = await ports.readFile(target.path);
    const share = created.share;
    const result = await uploader.upload(
      {
        shareId: share.id,
        fileName: target.fileName,
        bytes,
        contentType: contentTypeOf(target.path),
        expiresAt: share.expiresAt,
        ...(input.accessCode
          ? { accessCodeHash: hashShareAccessCode(input.accessCode, share.id) }
          : {}),
      },
      options,
    );
    if (!result.ok) {
      ports.logger?.warn('share.flow.failed', { shareId: share.id, reason: result.code });
      return { ok: false, code: result.code, refused: result.message };
    }

    const url = linkWithName(result.url, target.fileName);
    ports.persist({
      id: share.id,
      artifactId: input.artifactId,
      url,
      expiresAt: share.expiresAt,
      hasPassword: share.hasPassword,
      createdAt: share.createdAt,
    });
    ports.attachShare(input.artifactId, share.id);
    ports.logger?.info('share.flow.succeeded', { shareId: share.id, byteSize: bytes.byteLength });
    return { ok: true, shareId: share.id, url, expiresAt: share.expiresAt };
  }

  /**
   * 撤销 = 云端删除 + 链接失效（08 §7.2 规则 3）。
   *
   * **云端先删，本机后标**：反过来的话，云端删失败而本机已经标成"已撤销"，
   * 用户会以为链接失效了而它还活着 —— 那是这条流程里最不能出的错。
   */
  async function revokeShare(shareId: string): Promise<{ ok: boolean; refused?: string }> {
    if (!ports.findShare(shareId)) return { ok: false, refused: '找不到这条分享记录。' };
    const uploader = ports.uploader();
    if (!uploader) {
      return { ok: false, refused: '撤销要先登录 —— 链接在云上，本机改状态不会让它失效。' };
    }
    const gone = await uploader.revoke(shareId);
    if (!gone) {
      return { ok: false, refused: '云端没能删掉这份文件，链接还活着。稍后重试。' };
    }
    ports.markRevoked(shareId, ports.now());
    ports.logger?.info('share.flow.revoked', { shareId });
    return { ok: true };
  }

  return { plan, perform, performThread, revokeShare };
}

function refuse(refusal: ShareRefusal | { code: string; message: string }): ShareOutcome {
  return { ok: false, code: refusal.code, refused: refusal.message };
}

export type ShareFlow = ReturnType<typeof createShareFlow>;
