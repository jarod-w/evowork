/**
 * 分享上传（08 §7 的第 ② 步）。
 *
 * ## 这是本机内容离开设备的唯一常规出网路径，所以这个文件有三条额外纪律
 *
 * 1. **授权在前，读文件在后。** `createShare` 通过之前一个字节都不读 ——
 *    顺序反了的话，"用户取消了授权"与"文件已经被读进内存"会同时成立。
 * 2. **可取消，且取消要真的中止请求**（08 §7.1「进度可取消」）。
 *    只把 UI 上的进度条停掉、请求继续跑完，是最容易写出来的假取消。
 * 3. **失败即清理云端残留**（08 §8 最后一行）。断点不续传 ——
 *    分享文件通常不大，而续传要在云端留一个半截对象，那是个额外的数据面。
 *
 * ## 日志里没有文件名
 *
 * 与 Q14 同口径：文件名可能本身就是敏感信息（「XX公司裁员名单.xlsx」）。
 * 所以这里只记 `sizeBytes` / 耗时 / 结果码，路径与文件名走 digest。
 */

import { createHash } from 'node:crypto';

import type { Logger } from '@evowork/logging';

export interface UploadTarget {
  /** 上传端点。企业私有部署可换（Q14 的同一套配置思路） */
  readonly endpoint: string;
  readonly token: string;
}

export interface UploadInput {
  readonly shareId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly expiresAt: number;
  readonly passwordHash?: string | undefined;
}

export interface UploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}

export type UploadResult =
  | { readonly ok: true; readonly url: string; readonly expiresAt: number }
  | { readonly ok: false; readonly code: UploadFailure; readonly message: string };

export type UploadFailure = 'CANCELLED' | 'NETWORK' | 'REJECTED' | 'TOO_LARGE';

/** 单个分享文件的上限。超了直接拒绝，而不是传一半才发现。 */
export const MAX_SHARE_BYTES = 200 * 1024 * 1024;

export interface UploaderPorts {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly logger?: Logger | undefined;
}

export function digestName(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 16);
}

export function createUploader(target: UploadTarget, ports: UploaderPorts) {
  return {
    async upload(
      input: UploadInput,
      options: {
        readonly signal?: AbortSignal | undefined;
        readonly onProgress?: ((progress: UploadProgress) => void) | undefined;
      } = {},
    ): Promise<UploadResult> {
      const totalBytes = input.bytes.byteLength;
      if (totalBytes > MAX_SHARE_BYTES) {
        return {
          ok: false,
          code: 'TOO_LARGE',
          message: `这个文件有 ${Math.round(totalBytes / 1024 / 1024)}MB，超过分享的 200MB 上限。可以「另存为」发给对方。`,
        };
      }

      const startedAt = ports.now();
      options.onProgress?.({ uploadedBytes: 0, totalBytes });

      let response: Response;
      try {
        response = await ports.fetch(`${target.endpoint.replace(/\/$/, '')}/v1/shares`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${target.token}`,
            'content-type': input.contentType,
            'x-evowork-share-id': input.shareId,
            // 文件名以 digest 上传：云端不需要知道它，而它可能本身就是敏感信息
            'x-evowork-name-digest': digestName(input.fileName),
            'x-evowork-expires-at': String(input.expiresAt),
            ...(input.passwordHash ? { 'x-evowork-password': input.passwordHash } : {}),
          },
          /*
           * 用 Blob 而不是直接给 Uint8Array。
           *
           * 这个包同时被 Node 侧（宿主）与带 DOM lib 的渲染侧引用，而两边的 `BodyInit`
           * 定义不同 —— DOM 那边不接受 `Uint8Array<ArrayBufferLike>`。
           * 取 `.buffer` 拿到底层 ArrayBuffer，两边都认。
           */
          body: new Blob([input.bytes.buffer as ArrayBuffer], { type: input.contentType }),
          // 取消要真的中止请求，不只是停掉进度条
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (err) {
        const aborted = options.signal?.aborted === true;
        ports.logger?.warn('share.upload.failed', {
          byteSize: totalBytes,
          durationMs: ports.now() - startedAt,
          reason: aborted ? 'CANCELLED' : 'NETWORK',
        });
        // 失败即清理云端残留（08 §8）：断点不续传，半截对象不留
        await cleanup(input.shareId).catch(() => undefined);
        void err;
        return aborted
          ? { ok: false, code: 'CANCELLED', message: '已取消上传，云端不会留下这个文件。' }
          : { ok: false, code: 'NETWORK', message: '上传失败，网络没连上。稍后重试即可。' };
      }

      if (!response.ok) {
        ports.logger?.warn('share.upload.rejected', {
          statusCode: response.status,
          byteSize: totalBytes,
          durationMs: ports.now() - startedAt,
        });
        await cleanup(input.shareId).catch(() => undefined);
        return {
          ok: false,
          code: 'REJECTED',
          message:
            response.status === 413
              ? '服务端拒绝了这个文件：太大了。'
              : '服务端拒绝了这次分享。稍后重试，或联系管理员。',
        };
      }

      options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
      const body = (await response.json().catch(() => ({}))) as { url?: string };
      ports.logger?.info('share.upload.succeeded', {
        byteSize: totalBytes,
        durationMs: ports.now() - startedAt,
      });

      if (!body.url) {
        return { ok: false, code: 'REJECTED', message: '服务端没有返回分享链接。' };
      }
      return { ok: true, url: body.url, expiresAt: input.expiresAt };
    },

    /** 撤销 = 云端删除 + 链接失效（08 §7.2 规则 3）。 */
    async revoke(shareId: string): Promise<boolean> {
      const response = await ports
        .fetch(`${target.endpoint.replace(/\/$/, '')}/v1/shares/${shareId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${target.token}` },
        })
        .catch(() => undefined);
      return response?.ok === true;
    },
  };

  async function cleanup(shareId: string): Promise<void> {
    await ports.fetch(`${target.endpoint.replace(/\/$/, '')}/v1/shares/${shareId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${target.token}` },
    });
  }
}

/**
 * 分享密码只上传**哈希**，不上传明文。
 *
 * 云端只需要能验证"访问者输入的密码对不对"，不需要知道密码是什么 ——
 * 而用户很可能复用了别处的密码。
 */
export function hashSharePassword(password: string, shareId: string): string {
  return createHash('sha256').update(`${shareId}:${password}`).digest('hex');
}
