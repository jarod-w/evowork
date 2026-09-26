/**
 * 用真实 endpoint 核对一家 provider 的流式语义（work-priority §10 的 U2）。
 *
 * 这个脚本**不进 `pnpm run check`**：它要网络、要 key、要花钱。它的用途是
 * 在拿到额度后跑一次，把 `capabilities.ts` 里那些 `verified: false` 一个个变成
 * 有依据的 true/false，并把与 `translate/from-chat.ts` 假设不符的地方**报出来**。
 *
 * ## 它只打印形状，不打印正文
 *
 * Q14 的约束是「网关不落盘 prompt 与响应体」。这个脚本不是网关，但如果它把响应正文
 * 打到终端再被人贴进 issue，约束就等于没有。所以这里只输出：字段名、类型、计数、顺序。
 * 唯一的例外是错误 `code`（它本来就是我们要映射的枚举值，不含用户内容）。
 *
 * 用法：
 *   EVOWORK_PROBE_KEY=... node scripts/verify-provider.mjs \
 *     --base https://api.deepseek.com --model deepseek-v4-flash
 *
 * 可选开关：
 *   --reasoning true   这个型号**应该**吐 reasoning_content（断言的是"与能力表一致"）
 *   --image true       这个型号**应该**能读图（走 ⑤ 那一节，见下）
 */
import { argv, env, exit } from 'node:process';

const args = new Map();
for (let i = 2; i < argv.length; i += 2) args.set(argv[i]?.replace(/^--/, ''), argv[i + 1]);

const BASE = (args.get('base') ?? '').replace(/\/$/, '');
const MODEL = args.get('model') ?? '';
const KEY = env.EVOWORK_PROBE_KEY ?? '';

if (!BASE || !MODEL || !KEY) {
  console.error('缺少 --base / --model / EVOWORK_PROBE_KEY');
  exit(2);
}

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${id}${detail ? ` —— ${detail}` : ''}`);
}

/** 只留形状：键名 + 类型，值一律不带出来。 */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return depth > 2 ? 'array' : `[${value.length ? shape(value[0], depth + 1) : ''}]`;
  if (typeof value === 'object') {
    if (depth > 2) return 'object';
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}:${shape(v, depth + 1)}`)
      .join(',')}}`;
  }
  return typeof value;
}

async function post(body, { stream = false } = {}) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, ...body, ...(stream ? { stream: true } : {}) }),
  });
  return response;
}

/** 读一条 SSE 流，返回解析后的 chunk 数组（只保留形状分析需要的部分）。 */
async function readSse(response) {
  const chunks = [];
  let raw = '';
  let sawDone = false;
  const decoder = new TextDecoder();
  for await (const piece of response.body) {
    raw += decoder.decode(piece, { stream: true });
    let index;
    while ((index = raw.indexOf('\n\n')) >= 0) {
      const frame = raw.slice(0, index);
      raw = raw.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          sawDone = true;
          continue;
        }
        try {
          chunks.push(JSON.parse(payload));
        } catch {
          chunks.push({ __unparsable: true });
        }
      }
    }
  }
  return { chunks, sawDone };
}

// ── ① 非流式：响应形状 ───────────────────────────────────────────────
{
  const response = await post({
    messages: [{ role: 'user', content: '说“好”一个字' }],
    max_tokens: 8,
  });
  const body = await response.json();
  record('① 非流式 200', response.status === 200, `status=${response.status}`);
  record(
    '① choices[0].message.content 存在',
    typeof body?.choices?.[0]?.message?.content === 'string',
    shape(body?.choices?.[0] ?? null),
  );
  record('① usage 存在', body?.usage != null, shape(body?.usage ?? null));
  console.log(`   usage 字段：${Object.keys(body?.usage ?? {}).join(', ')}`);
}

// ── ② 流式：事件顺序、usage 位置、cache 字段 ────────────────────────
{
  const response = await post(
    {
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
      max_tokens: 64,
      stream_options: { include_usage: true },
    },
    { stream: true },
  );
  const { chunks, sawDone } = await readSse(response);
  record('② 有 [DONE] 终止帧', sawDone);
  record('② chunk 数 > 1（真流式）', chunks.length > 1, `chunks=${chunks.length}`);

  const withContent = chunks.filter((c) => typeof c?.choices?.[0]?.delta?.content === 'string');
  record(
    '② 增量在 choices[0].delta.content',
    withContent.length > 0,
    `${withContent.length} 个增量帧`,
  );

  const finishIndex = chunks.findIndex((c) => c?.choices?.[0]?.finish_reason);
  record('② finish_reason 出现', finishIndex >= 0, `第 ${finishIndex + 1}/${chunks.length} 帧`);

  const usageChunks = chunks.filter((c) => c?.usage != null);
  record(
    '② usage 随 include_usage 出现在流里',
    usageChunks.length > 0,
    `${usageChunks.length} 帧带 usage`,
  );
  if (usageChunks.length > 0) {
    const usage = usageChunks.at(-1).usage;
    console.log(`   usage 字段：${Object.keys(usage).join(', ')}`);
    record(
      '② 带 cache 口径字段（promptCache 能力位的依据）',
      'prompt_cache_hit_tokens' in usage || 'prompt_tokens_details' in usage,
      Object.keys(usage)
        .filter((k) => k.includes('cache') || k.includes('details'))
        .join(', ') || '无',
    );
    record(
      '② usage 帧的 choices 为空数组（我们按"最后一帧带 usage"处理）',
      Array.isArray(usageChunks.at(-1).choices),
      `choices=${shape(usageChunks.at(-1).choices)}`,
    );
  }

  /*
   * reasoning 的断言不是"应该没有"，而是"**和能力表说的一致**"。
   *
   * 第一版写成了"非推理型号不吐 reasoning_content"，结果对 deepseek-v4-flash 报红 ——
   * 而那不是缺陷，是这个名字带 flash 的模型确实会推理。断言写错的方向很值得记：
   * 它把"我以为的"当成了判据。真正的判据是能力表与上游是否一致，
   * 因为不一致会让 `from-chat.ts` 走进"上游给了思维链但能力表说没有"的分支，
   * 把推理段整块丢掉。
   */
  const reasoning = chunks.filter((c) => c?.choices?.[0]?.delta?.reasoning_content != null);
  const expectReasoning = args.get('reasoning') === 'true';
  record(
    `② reasoning_content 与 --reasoning=${expectReasoning} 一致`,
    reasoning.length > 0 === expectReasoning,
    `${reasoning.length} 帧带 reasoning_content`,
  );

  const first = chunks[0]?.choices?.[0]?.delta ?? {};
  console.log(`   首帧 delta 形状：${shape(first)}`);
}

// ── ③ 流式工具调用：按 index 累积参数 ───────────────────────────────
{
  const response = await post(
    {
      messages: [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询某个城市的天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 128,
    },
    { stream: true },
  );
  const { chunks } = await readSse(response);
  const toolChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls);
  record('③ 触发了工具调用', toolChunks.length > 0, `${toolChunks.length} 帧带 tool_calls`);

  if (toolChunks.length > 0) {
    const firstCall = toolChunks[0].choices[0].delta.tool_calls[0];
    console.log(`   首个 tool_call 帧形状：${shape(firstCall)}`);
    record(
      '③ 首帧带 index',
      typeof firstCall?.index === 'number',
      `index=${typeof firstCall?.index}`,
    );
    record(
      '③ 首帧带 id 与 function.name',
      Boolean(firstCall?.id) && Boolean(firstCall?.function?.name),
    );

    const later = toolChunks.slice(1).map((c) => c.choices[0].delta.tool_calls[0]);
    const idsAfterFirst = later.filter((t) => t?.id).length;
    record(
      '③ 后续帧只带 arguments 片段（id/name 不重复）',
      idsAfterFirst === 0,
      `${idsAfterFirst} 个后续帧重复带了 id`,
    );
    record(
      '③ 参数分片在 function.arguments',
      later.every((t) => t?.function === undefined || typeof t.function.arguments === 'string'),
    );
    const finish = chunks.map((c) => c?.choices?.[0]?.finish_reason).filter(Boolean);
    record('③ finish_reason = tool_calls', finish.includes('tool_calls'), finish.join(',') || '无');
  }
}

/*
 * ── ③b 并行工具调用：一次给出两个 tool_call ─────────────────────────
 *
 * 这一节是 2026-09-26 补的。`parallelToolCalls` 是能力表里**唯一一项没人验过、
 * 却三家都写着 true** 的能力位 —— ③ 只给了一个工具，拿到一个 tool_call 什么也证明不了。
 *
 * 标错的后果不对称：标 false 而上游支持，网关白做一次串行化（慢，但对）；
 * 标 true 而上游不支持，`from-chat.ts` 会按"同一帧里有多个 index"去重组参数，
 * 而上游其实是分两轮给的 —— 那是会错的那一侧。
 */
{
  const response = await post(
    {
      messages: [{ role: 'user', content: '北京现在天气怎么样？另外现在几点？两件事都用工具查。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询某个城市的天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: '查询当前时间',
            parameters: { type: 'object', properties: { tz: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      max_tokens: 512,
    },
    { stream: true },
  );
  const { chunks } = await readSse(response);
  const calls = new Map();
  for (const chunk of chunks) {
    for (const call of chunk?.choices?.[0]?.delta?.tool_calls ?? []) {
      if (call?.function?.name) calls.set(call.index, call.function.name);
    }
  }
  record(
    '③b 一轮里给出两个 tool_call（parallelToolCalls 能力位的依据）',
    calls.size >= 2,
    `${calls.size} 个 index：${[...calls.values()].join(', ') || '无'}`,
  );
}

/*
 * ── ⑥ prompt cache **命中**时字段叫什么 ──────────────────────────────
 *
 * ① / ② 只证明了"usage 里有 cache 相关字段"，而那是**未命中**时的形状。
 * 三家的命中字段各不相同（`prompt_cache_hit_tokens` / 嵌套 `prompt_tokens_details.cached_tokens`
 * / 顶层 `cached_tokens`），`translate/usage.ts` 依次读这三条路 ——
 * 读不到时**如实报 0**，而 0 是"不支持 cache"的合法取值，**所以漏读不会有人发现**
 * （2026-09-05 Kimi 的缓存命中永远显示 0 就是这么来的）。
 *
 * 判据只能是同一段长 prompt 发两次，看第二次哪条路非零。
 */
{
  // 固定前缀要够长（Kimi 要求 > 256 token 才进缓存），内容本身无意义
  const filler = '这是一段用于填满 prompt cache 最小长度的固定文本，内容本身没有意义。'.repeat(60);
  const messages = [
    { role: 'system', content: filler },
    { role: 'user', content: '只回答一个字：好。' },
  ];
  const paths = (usage) => ({
    'prompt_cache_hit_tokens（顶层）': usage?.prompt_cache_hit_tokens,
    'prompt_tokens_details.cached_tokens（嵌套）': usage?.prompt_tokens_details?.cached_tokens,
    'cached_tokens（顶层）': usage?.cached_tokens,
  });
  const ask = async () => {
    const res = await post({ messages, max_tokens: 16 });
    const body = await res.json().catch(() => null);
    return body?.usage ?? null;
  };
  await ask();
  const usage = await ask();
  if (usage) {
    console.log(`   第二次 usage 字段：${Object.keys(usage).join(', ')}`);
    if (usage.prompt_tokens_details) {
      console.log(`   prompt_tokens_details：${shape(usage.prompt_tokens_details)}`);
    }
    const hit = Object.entries(paths(usage)).filter(([, v]) => typeof v === 'number' && v > 0);
    record(
      '⑥ 第二次同 prompt 报出 cache 命中，且落在我们会读的那三条路之一',
      hit.length > 0,
      hit.length > 0
        ? hit.map(([k, v]) => `${k}=${v}`).join(' · ')
        : '三条路都读不到 —— 用量视图会把命中如实报成 0，而那看起来像"不支持 cache"',
    );
  } else {
    record('⑥ 第二次同 prompt 报出 cache 命中', false, '拿不到 usage');
  }
}

/*
 * ── ⑤ 图片输入：**"收下了"不算，"看见了"才算** ──────────────────────
 *
 * 这一节是 2026-09-26 补的，起因是一条能力位缺陷（status.md 同日那节）。
 * 它单独存在的理由写在 D2：**`imageInput` 有三种结局，不是两种** ——
 * 真能看 · 明确拒绝 · **接受请求但看不见**。第三种（deepseek-v4-flash 实测如此）
 * HTTP 200、无报错、回一句"无法识别"，所以**只看状态码的探针会把它判成支持**。
 *
 * 判据因此只能是模型答没答对颜色：发一张 32×32 纯红 PNG，问它什么颜色。
 * 答不上来 = 看不见，无论 HTTP 多少。
 *
 * 仍然不打印正文（文件头那条约束）：只报匹配到的那个颜色词与字符数。
 */
{
  const expectImage = args.get('image') === 'true';
  if (expectImage) {
    // 32×32 纯红 PNG（96 字节）。选纯色是因为判据必须是**一个词**，不能是"描述得合理"
    const RED_PNG =
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/' +
      'tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC';
    const response = await post({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么颜色？只回答颜色名。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
          ],
        },
      ],
      // 推理型号会把小预算全花在思维链上，给 512 是为了让它有机会真的回话（D2 那条观察）
      max_tokens: 512,
    });
    const ok = response.ok;
    record('⑤ 带图请求没被拒', ok, `status=${response.status}`);
    if (ok) {
      const body = await response.json().catch(() => null);
      const text = body?.choices?.[0]?.message?.content ?? '';
      const hit = /红|red|crimson|scarlet/i.exec(typeof text === 'string' ? text : '');
      record(
        '⑤ **模型真的看见了**（答出纯红图的颜色）',
        hit !== null,
        hit
          ? `命中「${hit[0]}」`
          : `没提到颜色（回了 ${String(text).length} 字）—— 这就是"收下但看不见"`,
      );
    } else {
      const body = await response.json().catch(() => null);
      console.log(`   拒绝的错误体形状：${shape(body)}`);
    }
  } else {
    console.log('⏭️  ⑤ 图片输入：未加 --image true，跳过');
  }
}

// ── ④ 错误映射：未知模型 ────────────────────────────────────────────
{
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: '__no_such_model__',
      messages: [{ role: 'user', content: 'x' }],
    }),
  });
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? body?.error?.type ?? null;
  record(
    '④ 未知模型返回 4xx',
    response.status >= 400 && response.status < 500,
    `status=${response.status}`,
  );
  console.log(`   错误体形状：${shape(body)}`);
  console.log(`   error.code / type：${code ?? '无'}`);
  record(
    '④ 永久性错误能被识别（否则内核会当成可重试，一直重试到上限）',
    response.status === 400 || response.status === 404 || response.status === 422,
    `status=${response.status}`,
  );
}

const failed = findings.filter((f) => !f.ok);
console.log(
  `\n共 ${findings.length} 条，通过 ${findings.length - failed.length}，不符 ${failed.length}`,
);
if (failed.length > 0) {
  console.log('不符的断言：');
  for (const f of failed) console.log(`  · ${f.id}${f.detail ? ` (${f.detail})` : ''}`);
}
exit(failed.length > 0 ? 1 : 0);
