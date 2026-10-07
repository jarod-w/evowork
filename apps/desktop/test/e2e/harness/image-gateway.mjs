/** 真网关翻译 + 可控 Chat 上游 + 图片服务夹具/真实 Ark；只保存统计，不保存请求正文。 */
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import { startRealGateway } from './real-gateway.mjs';

const modelIds = ['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628'];

export async function createImageGateway({ repoRoot, workspace, home, mode }) {
  if (!['fixture', 'unavailable', 'real'].includes(mode)) throw new Error('IMAGE_E2E_MODE_INVALID');
  const key = mode === 'real' ? process.env.EVOWORK_UI_IMAGE_KEY : undefined;
  if (mode === 'real' && !key) throw new Error('需要 EVOWORK_UI_IMAGE_KEY；不跳过真实图片测试。');
  const base = new URL(
    process.env.EVOWORK_UI_IMAGE_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3/',
  );
  if (base.protocol !== 'https:') throw new Error('IMAGE_E2E_ENDPOINT_INVALID');
  const stats = {
    imagePosts: 0,
    imageModels: [],
    viewCalls: 0,
    visualRequests: 0,
    imageBytesInToolText: false,
    imageUrlLength: 0,
  };
  let fixturePng;
  function png() {
    if (fixturePng) return fixturePng;
    // 大图确保旧实现的 Base64 文字串确实会超过测试聊天模型 32K 上限。
    const pixels = Buffer.alloc(2048 * 2048 * 4);
    let seed = 123;
    for (let i = 0; i < pixels.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[i] = seed & 255;
      pixels[i + 1] = (seed >>> 8) & 255;
      pixels[i + 2] = (seed >>> 16) & 255;
      pixels[i + 3] = 255;
    }
    fixturePng = nativeImage.createFromBitmap(pixels, { width: 2048, height: 2048 }).toPNG();
    return fixturePng;
  }
  const server = createServer((req, res) => {
    void (async () => {
      const json = (status, body) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/models') return json(200, { data: modelIds.map((id) => ({ id })) });
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      if (req.url === '/images/generations') {
        stats.imagePosts++;
        stats.imageModels.push(body.model);
        // 一次测试只允许一笔付费请求；重复调用在到达真实服务商前拒绝。
        if (stats.imagePosts > 1)
          return json(429, { error: { code: 'E2E_DUPLICATE_PAID_REQUEST' } });
        if (mode === 'unavailable') return json(404, { error: { code: 'ModelNotFound' } });
        if (mode === 'fixture')
          return json(200, { data: [{ b64_json: png().toString('base64') }] });
        const reply = await fetch(new URL('images/generations', base), {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: raw,
          signal: AbortSignal.timeout(300_000),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        for await (const part of reply.body) res.write(part);
        return res.end();
      }
      if (req.url !== '/chat/completions') return json(404, {});
      const messages = body.messages ?? [];
      const toolText = messages
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('');
      if (toolText.includes('data:image/')) {
        stats.imageBytesInToolText = true;
        return json(400, {
          error: {
            code: 'context_length_exceeded',
            message: 'maximum context length exceeded by image Base64 tool text',
          },
        });
      }
      const images = messages.flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : [],
      );
      const calls = messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
      let delta;
      if (!JSON.stringify(messages).includes('生成一张天空图片')) {
        delta = { content: '准备就绪。' };
      } else if (!calls.some((name) => name.endsWith('image_generate'))) {
        const name = body.tools?.find((t) => t.function.name.endsWith('image_generate'))?.function
          .name;
        if (!name) throw new Error('IMAGE_TOOL_NOT_DISCOVERED');
        delta = {
          tool_calls: [
            {
              index: 0,
              id: 'image_call',
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify({
                  prompt: '蓝色天空，白色积云，自然日光，写实摄影，单张图片。',
                }),
              },
            },
          ],
        };
      } else if (!calls.some((name) => name.endsWith('view_image'))) {
        // 内核可能在 MCP JSON 前加工具结果说明；按字段识别，最终状态另由公开 IPC 断言。
        const status = toolText.match(/"status"\s*:\s*"(completed|cancelled|failed)"/)?.[1];
        const errorCode = toolText.match(/"errorCode"\s*:\s*"([A-Z_]+)"/)?.[1];
        if (status === 'cancelled') {
          delta = { content: '已取消生成，没有发起付费请求。' };
        } else if (status !== 'completed') {
          delta = { content: '图片生成失败：' + (errorCode ?? 'IMAGE_OPERATION_FAILED') };
        } else {
          const root = join(workspace, 'artifacts/images');
          const file = existsSync(root)
            ? readdirSync(root)
                .map((id) => join(root, id, 'result.png'))
                .find(existsSync)
            : undefined;
          if (!file) throw new Error('IMAGE_FILE_NOT_DELIVERED');
          const name = body.tools?.find((t) => /(^|__)view_image$/.test(t.function.name))?.function
            .name;
          if (!name) throw new Error('VIEW_IMAGE_TOOL_NOT_DISCOVERED');
          stats.viewCalls++;
          delta = {
            tool_calls: [
              {
                index: 0,
                id: 'view_call',
                type: 'function',
                function: { name, arguments: JSON.stringify({ path: file }) },
              },
            ],
          };
        }
      } else {
        if (images.length !== 1) throw new Error('IMAGE_VISUAL_INPUT_MISSING');
        stats.visualRequests++;
        stats.imageUrlLength = images[0].image_url.url.length;
        delta = { content: '天空图片已生成并查看，任务完成。' };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4000, completion_tokens: 100, total_tokens: 4100 } })}\n\ndata: [DONE]\n\n`,
      );
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'IMAGE_E2E_UPSTREAM_FAILED' } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const upstream = 'http://127.0.0.1:' + server.address().port + '/';
  let gateway;
  try {
    gateway = await startRealGateway({
      repoRoot,
      keyEnvName: 'EVOWORK_UI_FAKE_KEY',
      apiKey: 'e2e-chat-key',
      logFile: join(home, 'gateway.log'),
      entryPath: process.env.EVOWORK_UI_IMAGE_GATEWAY_ENTRY,
      env: {
        ARK_API_KEY: 'e2e-proxy-key',
        ARK_BASE_URL: upstream,
        EVOWORK_DISABLE_IMAGE_GENERATION: '0',
      },
      customModels: ['e2e-model', 'e2e-model-alt'].map((id) => ({
        id,
        displayName: id,
        provider: 'private',
        upstreamModel: id,
        baseUrl: upstream,
        keyEnv: 'EVOWORK_UI_FAKE_KEY',
        capabilities: {
          streaming: true,
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: false,
          promptCache: false,
          imageInput: true,
          maxContextTokens: 32000,
        },
      })),
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    pid: gateway.pid,
    token: gateway.token,
    listen: async () => gateway.baseUrl,
    stats: () => ({ ...stats }),
    stop: () => {
      gateway.stop();
      server.closeAllConnections();
      server.close();
    },
  };
}
