/** 图片工具只接收不透明引用；真实任务身份来自适配层正在执行的 MCP item。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  createImageService,
  inspectPng,
  inspectImageInput,
  type ImageContext,
} from '@evowork/image-generation';
import {
  boundedImageJson,
  IMAGE_API_BASE,
  IMAGE_MODELS,
  imageBaseUrl,
  imageModelId,
  ImageApiError,
  type ImageResponse,
} from '@evowork/gateway';
import { readMeta, writeMeta, type Store } from '@evowork/store';
import type { Adapter } from '@evowork/kernel-adapter';
import type { AccountVault } from './account.js';
import type {
  ComposerAttachmentView,
  ImageSettingsView,
  SaveImageSettingsInput,
  ImageOperationView,
} from '../shared/ipc.js';
export interface ImageHostOptions {
  store: Store;
  adapter: () => Adapter;
  vault: AccountVault;
  secretBackend: string;
  keyPresent?: (() => boolean) | undefined;
  gateway: () => { baseUrl: string; token?: string };
  denied: () => boolean;
  configure: (enabled: boolean) => void;
  restartGateway: () => Promise<void>;
  normalize?: ((bytes: Buffer) => Buffer) | undefined;
  changed?: ((threadId: string) => void) | undefined;
}
export function createImageHost(options: ImageHostOptions) {
  let token = randomBytes(32).toString('base64url');
  const bindings = new Map<string, () => boolean>();
  const readConfig = () => {
    const raw = readMeta(options.store.db, 'image.settings');
    try {
      const saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      return {
        enabled: saved.enabled === true,
        model: imageModelId(typeof saved.model === 'string' ? saved.model : IMAGE_MODELS[0].id),
        baseUrl: imageBaseUrl(typeof saved.baseUrl === 'string' ? saved.baseUrl : IMAGE_API_BASE),
      };
    } catch {
      return { enabled: false, model: IMAGE_MODELS[0].id, baseUrl: IMAGE_API_BASE };
    }
  };
  const view = (): ImageSettingsView => ({
    ...readConfig(),
    enabled: readConfig().enabled && !options.denied(),
    hasKey: options.keyPresent?.() ?? !!options.vault.get('ARK_API_KEY'),
    models: IMAGE_MODELS,
    secretBackend: options.secretBackend,
  });
  const valid = (context: ImageContext) => {
    const row = options.store.threads.get(context.threadId);
    return (
      readConfig().enabled &&
      !options.denied() &&
      !!row &&
      row.cwd === context.cwd &&
      readConfig().model === context.model &&
      readConfig().baseUrl === context.baseUrl &&
      options.adapter().isDesktopInteractiveTurn(context.threadId, context.turnId) &&
      bindings.get(context.callId)?.() === true
    );
  };
  const service = createImageService({
    db: options.store.db,
    valid,
    validateOutput: (bytes) => {
      if (options.normalize) options.normalize(bytes);
    },
    ...(options.changed ? { changed: options.changed } : {}),
    indexed: (threadId) => options.store.threads.incrementArtifactCount(threadId),
    ask: async (context, message, signal) => {
      const choice = '确认本次上传与费用';
      const reply = await Promise.race([
        options.adapter().requestComputerUseConsent({
          id: 'image_' + randomUUID(),
          kind: 'mcp',
          threadId: context.threadId,
          turnId: context.turnId,
          unattended: false,
          receivedAtMs: Date.now(),
          params: {
            mode: 'form',
            serverName: 'image_generation',
            message,
            requestedSchema: {
              type: 'object',
              properties: { scope: { type: 'string', enum: [choice, '取消'] } },
              required: ['scope'],
            },
          },
        }),
        new Promise<{ decision: 'cancel' }>((resolve) => {
          if (signal.aborted) resolve({ decision: 'cancel' });
          else
            signal.addEventListener('abort', () => resolve({ decision: 'cancel' }), { once: true });
        }),
      ]);
      return reply.decision === 'accept' && 'optionId' in reply && reply.optionId === choice;
    },
    submit: async (request, signal) => {
      const gateway = options.gateway();
      try {
        const response = await fetch(
          new URL('evowork/image-operations', gateway.baseUrl.replace(/\/?$/, '/')),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(gateway.token ? { Authorization: 'Bearer ' + gateway.token } : {}),
            },
            body: JSON.stringify(request),
            signal: AbortSignal.any([signal, AbortSignal.timeout(310_000)]),
            redirect: 'error',
          },
        );
        const body = (await boundedImageJson(response)) as ImageResponse & {
          error?: { code?: string; outcomeUnknown?: boolean };
        };
        if (!response.ok)
          throw new ImageApiError(
            body.error?.code ?? 'IMAGE_GATEWAY_FAILED',
            body.error?.outcomeUnknown ?? response.status >= 500,
          );
        return body;
      } catch (e) {
        if (e instanceof ImageApiError) throw e;
        throw new ImageApiError('IMAGE_OUTCOME_UNKNOWN', true);
      }
    },
  });
  function stop(threadId?: string) {
    service.cancel(threadId);
    if (!threadId) bindings.clear();
    options.adapter().cancelImageApprovals();
  }
  const server = createServer((req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/call' ||
      req.headers.authorization !== 'Bearer ' + token
    ) {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (part: Buffer) => {
      length += part.length;
      if (length > 65536) req.destroy();
      else chunks.push(part);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            threadId?: unknown;
            sessionId?: unknown;
            name?: unknown;
            arguments?: unknown;
          };
          if (
            typeof call.threadId !== 'string' ||
            typeof call.sessionId !== 'string' ||
            typeof call.name !== 'string'
          )
            throw new ImageApiError('IMAGE_CONTEXT_DENIED');
          if (!readConfig().enabled || options.denied() || !view().hasKey)
            throw new ImageApiError('IMAGE_DISABLED');
          if (!['image_generate', 'image_edit'].includes(call.name))
            throw new ImageApiError('IMAGE_TOOL_UNKNOWN');
          const args = call.arguments as { prompt?: unknown; imageRef?: unknown };
          if (
            !args ||
            Object.keys(args).some((k) => !['prompt', 'imageRef'].includes(k)) ||
            typeof args.prompt !== 'string' ||
            (call.name === 'image_edit'
              ? typeof args.imageRef !== 'string'
              : args.imageRef !== undefined)
          )
            throw new ImageApiError('IMAGE_REQUEST_INVALID');
          const bound = options
            .adapter()
            .resolveImageToolCall(call.threadId, call.name, call.arguments);
          const row = options.store.threads.get(call.threadId);
          if (!bound || !row?.cwd) throw new ImageApiError('IMAGE_CONTEXT_DENIED');
          bindings.set(bound.callId, () => {
            const current = options
              .adapter()
              .resolveImageToolCall(call.threadId as string, call.name as string, call.arguments);
            return current?.callId === bound.callId && current.generation === bound.generation;
          });
          try {
            const op = await service.run(
              {
                threadId: call.threadId,
                turnId: bound.turnId,
                callId: bound.callId,
                cwd: row.cwd,
                model: readConfig().model,
                baseUrl: readConfig().baseUrl,
              },
              {
                prompt: args.prompt,
                ...(typeof args.imageRef === 'string' ? { imageRef: args.imageRef } : {}),
              },
            );
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(
              JSON.stringify({
                operationId: op.id,
                status: op.status,
                artifactId: op.artifact_id,
                imageRef: op.artifact_id,
                width: op.width,
                height: op.height,
                errorCode: op.error_code,
              }),
            );
          } finally {
            bindings.delete(bound.callId);
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              errorCode: e instanceof ImageApiError ? e.code : 'IMAGE_REQUEST_FAILED',
            }),
          );
        }
      })();
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  ready.catch(() => undefined);
  const endpoint = () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('IMAGE_HOST_UNAVAILABLE');
    return 'http://127.0.0.1:' + address.port + '/call';
  };
  options.configure(view().enabled && view().hasKey);
  return {
    ready,
    get environment() {
      return { EVOWORK_IMAGE_ENDPOINT: endpoint(), EVOWORK_IMAGE_TOKEN: token };
    },
    env() {
      return {
        ARK_BASE_URL: readConfig().baseUrl,
        EVOWORK_DISABLE_IMAGE_GENERATION: view().enabled ? '0' : '1',
      };
    },
    register: service.register,
    prepareAttachments(
      root: string,
      attachments: readonly ComposerAttachmentView[],
    ): readonly ComposerAttachmentView[] {
      if (!view().enabled) throw new Error('请先在设置 → 模型中启用 AI 图片。');
      return attachments.map((a) => {
        if (a.state !== 'ready' || a.kind !== 'image')
          throw new Error('AI 编辑仅接受 PNG、JPEG 或 WebP 图片。');
        const references = a.references.map((ref) => {
          if (ref.type !== 'localImage') throw new Error('请选择图片文件。');
          const realRoot = realpathSync(root),
            path = realpathSync(ref.path),
            rel = relative(realRoot, path);
          if (
            !rel ||
            rel === '..' ||
            rel.startsWith('..' + sep) ||
            path !== ref.path ||
            !lstatSync(path).isFile()
          )
            throw new Error('图片不在已选附件目录中。');
          if (lstatSync(path).size > 10 * 1024 * 1024) throw new Error('编辑图片应小于 10 MiB。');
          const bytes = readFileSync(path);
          if (bytes.length > 10 * 1024 * 1024) throw new Error('编辑图片应小于 10 MiB。');
          inspectImageInput(bytes);
          const normalized = options.normalize?.(bytes);
          if (!normalized) throw new Error('当前构建缺少图片解码器。');
          inspectPng(normalized);
          if (normalized.length > 10 * 1024 * 1024) throw new Error('标准化图片超过 10 MiB。');
          const copy = join(dirname(path), 'image-edit-' + randomUUID() + '.png');
          writeFileSync(copy, normalized, { mode: 0o600, flag: 'wx' });
          return { ...ref, path: copy, purpose: 'imageEdit' as const };
        });
        return { ...a, references };
      });
    },
    view,
    async verify() {
      if (!view().enabled || !view().hasKey) throw new Error('请先保存密钥并启用 AI 图片。');
      const gateway = options.gateway();
      const response = await fetch(
        new URL('evowork/image-models', gateway.baseUrl.replace(/\/?$/, '/')),
        {
          headers: { ...(gateway.token ? { Authorization: 'Bearer ' + gateway.token } : {}) },
          redirect: 'error',
          signal: AbortSignal.timeout(25_000),
        },
      );
      const result = (await boundedImageJson(response)) as {
        models?: { id: string; available: boolean }[];
        error?: { code: string };
      };
      if (!response.ok) throw new Error(result.error?.code ?? 'IMAGE_DIRECTORY_UNAVAILABLE');
      return result.models?.some((m) => m.id === view().model && m.available)
        ? '密钥和型号目录验证通过；本次未生成图片，生成/编辑仍需单独费用确认。'
        : '服务商目录未列出所选型号，请检查账户权限或选择其它型号。';
    },
    async save(input: SaveImageSettingsInput) {
      if (service.busy()) throw new Error('请先停止正在进行的图片操作，再修改设置。');
      const model = imageModelId(input.model),
        baseUrl = imageBaseUrl(input.baseUrl);
      if (input.apiKey && !options.vault.set('ARK_API_KEY', input.apiKey.trim()))
        throw new Error('系统密钥库不可用，密钥未保存。');
      if (input.clearKey) options.vault.remove('ARK_API_KEY');
      writeMeta(
        options.store.db,
        'image.settings',
        JSON.stringify({ enabled: input.enabled === true, model, baseUrl }),
      );
      options.configure(view().enabled && view().hasKey);
      await options.restartGateway();
      return view();
    },
    list(threadId: string): ImageOperationView[] {
      return service.list(threadId).map((o) => ({
        id: o.id,
        callId: o.call_id,
        status: o.status,
        model: o.model,
        artifactId: o.artifact_id,
        parentId: o.parent_id,
        width: o.width,
        height: o.height,
        errorCode: o.error_code,
        submitted: o.submitted_at !== null,
      }));
    },
    recover: service.recover,
    acknowledge(threadId: string, operationId: string) {
      service.acknowledge(threadId, operationId);
    },
    extendBudget(threadId: string) {
      service.extendBudget(threadId);
    },
    stop,
    remove(threadId: string) {
      service.remove(threadId);
    },
    rotate() {
      stop();
      token = randomBytes(32).toString('base64url');
    },
    close() {
      stop();
      server.closeAllConnections();
      server.close();
    },
  };
}
export type ImageHost = Awaited<ReturnType<typeof createImageHost>>;
