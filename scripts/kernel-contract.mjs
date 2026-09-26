#!/usr/bin/env node
/**
 * K2 自检：**我们发给内核的 JSON 形状，对不对得上内核真正接受的形状**。
 *
 * ## 为什么要这个脚本
 *
 * 2026-09-26 一张截图（`turn/interrupt 失败 (code -32600)`）查下去，发现同一类缺陷有 13 处。
 * 它们的共同点不是「难」，而是**发现不了**：
 *
 *   - 漏一个必填字段 → 内核在反序列化阶段打回 -32600。「停止」按钮从来没成功过一次，
 *     而错误弹窗里只有一个裸错误码（Q14 让 rpcMessage 不进 Error.message）。
 *   - 枚举拼法写错（`recencyAt` vs `recency_at`）→ 同样 -32600，而调用方 `.catch` 掉之后
 *     **一行日志都没有**：一致性校正每十分钟失败一次，藏了不知道多久。
 *   - 回复的形状不对 → 内核**根本不报错**，`unwrap_or_else` 兜一个默认值。用户点「允许」
 *     和点「拒绝」授予的东西一样多：都是零。
 *
 * 之所以能带着全绿的测试上线，是因为假内核收什么都回成功，而断言只看 method 名。
 * 补几条断言解决不了这个 —— 断言只钉住「已经知道要看的东西」。
 *
 * ## 它怎么工作
 *
 * **直接读内核源码**，不读我们自己写的镜像类型 —— 所以它不会过期：
 *
 *   ① 从 `protocol/common.rs` 的宏表解出「方法名 → 参数结构体名」；
 *   ② 递归解析 `app-server-protocol/src` 下的全部 `.rs` 结构体，按 `Option<>` / `#[serde(default)]` /
 *      `rename_all` / `rename` 判定每个字段**在线上是否必填、线上叫什么名字**；
 *   ③ 解析枚举，拿到每个变体**在线上的拼法**（snake_case / camelCase / kebab-case / 显式 rename）；
 *   ④ 把下面 `OUTGOING` 这张表逐条对过去。
 *
 * ## 为什么是一张手写的表，而不是去解析我们的 TS
 *
 * 用正则从 TS 里抠对象字面量，一次性排查够用，当成常驻检查会不断误报，
 * 而**会误报的检查最后一定被关掉**。所以改成：形状显式声明在这里，脚本负责证明它对。
 *
 * 表会不会和代码脱节？`checkCoverage()` 扫适配层里所有 `METHOD.x` / `EXPERIMENTAL_METHOD.x`
 * 的引用，少一条就失败 —— 新增一个调用点必须在这里登记。
 *
 * 用法：
 *   node scripts/kernel-contract.mjs            # 人读的报告
 *   node scripts/kernel-contract.mjs --json
 *   EVOWORK_KERNEL_DIR=/path/to/codex node scripts/kernel-contract.mjs
 *
 * 退出码：0 = 全部对得上；1 = 有对不上的；2 = 读不到内核（本地没签出时**不失败**，只提示）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = resolve(process.env.EVOWORK_KERNEL_DIR ?? join(REPO_ROOT, '..', 'codex'));
const PROTOCOL_SRC = join(KERNEL_DIR, 'codex-rs/app-server-protocol/src');

/**
 * 我们发给内核的每一个请求，及其参数形状。
 *
 * `keys`   —— 一定会发的键。
 * `maybe`  —— 条件发送的键（`...(x ? { k } : {})`）。**必填字段不许放这里**，脚本会拦。
 * `values` —— 我们写死的枚举字面量，逐个拿去和内核的变体拼法对。
 *
 * 每条都值得写一句「为什么是这个形状」，尤其是踩过坑的那几条。
 */
const OUTGOING = {
  'thread/name/set': { keys: ['threadId', 'name'] },
  'thread/resume': { keys: ['threadId'] },
  'thread/read': { keys: ['threadId'], maybe: ['includeTurns'] },
  'thread/list': {
    keys: ['limit', 'useStateDbOnly'],
    maybe: ['sortKey'],
    // **snake_case**，和协议里其余的驼峰不一样。写成 `recencyAt` 不是"这个字段被忽略"，
    // 而是整个请求被打回 -32600 —— 一致性校正（09 §4.1）每次都失败，而且没人看得见。
    values: { sortKey: 'recency_at' },
  },
  'thread/start': { keys: ['model', 'approvalPolicy', 'approvalsReviewer'], maybe: '*' },
  'thread/fork': { keys: ['threadId', 'excludeTurns'], maybe: ['lastTurnId', 'ephemeral'] },
  'thread/archive': { keys: ['threadId'] },
  'thread/delete': { keys: ['threadId'] },
  'thread/revert': { keys: ['threadId', 'beforeTurnId'] },
  'thread/items/list': { keys: ['threadId', 'limit'], maybe: ['cursor'] },
  'thread/turns/list': {
    keys: ['threadId', 'limit', 'sortDirection', 'itemsView'],
    values: { sortDirection: 'desc', itemsView: 'summary' },
  },
  'thread/goal/get': { keys: ['threadId'] },
  'thread/goal/set': { keys: ['threadId'], maybe: ['objective', 'status', 'tokenBudget'] },
  'thread/goal/clear': { keys: ['threadId'] },
  'turn/start': { keys: ['threadId', 'input'], maybe: '*' },
  // `expectedTurnId` 是内核的活动回合前置条件，且**不接受空串**
  // （`turn_processor.rs:1038`）。漏掉它 = 勾了「立即插话」永远发不出去。
  'turn/steer': { keys: ['threadId', 'input', 'expectedTurnId'] },
  // 两个字段都没有 `Option`。漏掉 `turnId` = 「停止」按钮从来没成功过一次。
  // 空串是内核定义的「启动期中断」，是合法值，所以这里只要求**键在**。
  'turn/interrupt': { keys: ['threadId', 'turnId'] },
  'skills/extraRoots/set': { keys: ['extraRoots'] },
  'skills/list': { maybe: ['cwds', 'forceReload'] },
  'skills/config/write': { keys: ['enabled'], maybe: ['path', 'name'] },
  'config/read': { keys: ['includeLayers', 'cwd'] },
  'config/batchWrite': { keys: ['edits'] },
  'config/mcpServer/reload': { keys: [] },
  'permissionProfile/list': { keys: [] },
  'experimentalFeature/list': { keys: [] },
  fuzzyFileSearch: { keys: ['query', 'roots', 'cancellationToken'] },
  'mcpServerStatus/list': {
    keys: ['detail'],
    maybe: ['threadId'],
    values: { detail: 'toolsAndAuthOnly' },
  },
  'mcpServer/oauth/login': { keys: ['name'], maybe: ['threadId'] },
  'plugin/list': {
    keys: ['cwds', 'marketplaceKinds', 'forceRefetch'],
    values: { marketplaceKinds: ['local', 'workspace-directory'] },
  },
  'plugin/install': {
    keys: ['marketplacePath', 'remoteMarketplaceName', 'installAttemptId', 'pluginName'],
  },
  'plugin/uninstall': { keys: ['pluginId'] },
  'project/list': { keys: [] },
  // `idempotencyKey` 是 String 不是 Option（`v2/project.rs`）。镜像调用失败是静默的，
  // 漏了它的表现是「内核那边永远建不出空间」，而且没有任何征兆。
  'project/create': { keys: ['name', 'roots', 'idempotencyKey'] },
  'project/update': { keys: ['projectId'], maybe: ['name'] },
  'project/delete': { keys: ['projectId'] },
  'thread/search': {
    keys: ['searchTerm', 'limit', 'sortKey', 'sortDirection'],
    values: { sortKey: 'recency_at', sortDirection: 'desc' },
  },
  'thread/searchOccurrences': { keys: ['threadId', 'searchTerm', 'limit'] },
  'thread/queue/add': { keys: ['threadId', 'input', 'clientUserMessageId'] },
  'thread/queue/list': { keys: ['threadId', 'limit'] },
  'thread/queue/delete': { keys: ['threadId', 'queuedSubmissionId'] },
  'thread/queue/update': { keys: ['threadId', 'queuedSubmissionId', 'input'] },
  'thread/queue/reorder': { keys: ['threadId', 'queuedSubmissionIds'] },
  'memory/status': { keys: [] },
  'memory/reset': { keys: [] },
  'thread/memoryMode/set': { keys: ['threadId', 'mode'], values: { mode: 'enabled' } },
};

/** 不经 `OUTGOING` 校验的方法，每条都要写明为什么。 */
const OUTGOING_EXEMPT = {
  initialize: '握手用 v1 参数，不在 v2 的结构体表里',
  initialized: '通知，不是请求',
};

/**
 * 我们**读**内核通知里的哪些字段。读错的字段不会报错，只是恒为 undefined ——
 * `thread/name/updated` 读成 `name` 时，每收到一条重命名就把标题抹成 null。
 */
const INCOMING = {
  'thread/started': ['thread'],
  'thread/status/changed': ['threadId', 'status'],
  'thread/name/updated': ['threadId', 'threadName'],
  'thread/archived': ['threadId'],
  'thread/unarchived': ['threadId'],
  'thread/deleted': ['threadId'],
  'turn/started': ['threadId', 'turn'],
  'turn/completed': ['threadId', 'turn'],
  'turn/plan/updated': ['threadId', 'turnId', 'explanation', 'plan'],
  'turn/diff/updated': ['threadId', 'turnId', 'diff'],
  'item/started': ['threadId', 'turnId', 'item'],
  'item/completed': ['threadId', 'turnId', 'item'],
  'thread/tokenUsage/updated': ['threadId', 'tokenUsage'],
  'thread/queue/changed': ['threadId'],
  'thread/goal/updated': ['threadId', 'goal'],
  'thread/goal/cleared': ['threadId'],
  'thread/settings/updated': ['threadId'],
  'project/changed': [],
  'skills/changed': [],
  // `{ watchId, changedPaths }` —— **没有 threadId**。以前读 threadId，永远是 undefined。
  'fs/changed': ['watchId', 'changedPaths'],
  'account/rateLimits/updated': [],
  warning: ['message'],
  'item/fileChange/patchUpdated': ['threadId', 'turnId', 'itemId', 'changes'],
  'item/mcpToolCall/progress': ['threadId', 'itemId'],
  'item/agentMessage/delta': ['threadId', 'itemId', 'delta'],
  'item/plan/delta': ['threadId', 'itemId', 'delta'],
  'item/reasoning/textDelta': ['threadId', 'itemId', 'delta'],
  'item/reasoning/summaryTextDelta': ['threadId', 'itemId', 'delta'],
  'item/commandExecution/outputDelta': ['threadId', 'itemId', 'delta'],
};

/**
 * 我们从服务端请求的 **params** 里读哪些字段。
 *
 * 审批卡画错就是从这里开始的：读 `params.question`（内核发的是 `questions`）→
 * 卡片标题写着「需要你回答」、底下一个字都没有，而且不报错。
 */
const REQUEST_READS = {
  'item/commandExecution/requestApproval': [
    'threadId',
    'turnId',
    'itemId',
    'reason',
    'command',
    'cwd',
    // `"command" | "writeStdin"` —— 后者是往已经在跑的进程写输入，不是启动命令
    'kind',
  ],
  'item/fileChange/requestApproval': ['threadId', 'turnId', 'itemId', 'reason'],
  'item/permissions/requestApproval': [
    'threadId',
    'turnId',
    'itemId',
    'reason',
    'cwd',
    'permissions',
  ],
  'item/tool/requestUserInput': ['threadId', 'turnId', 'itemId', 'questions'],
  'mcpServer/elicitation/request': ['threadId', 'turnId', 'serverName'],
};

/**
 * 我们**回**给内核的服务端请求，形状由内核的 `*Response` 结构体规定。
 *
 * 这一类最危险：形状不对内核**不报错**，`unwrap_or_else` 兜一个默认值
 * （`bespoke_event_handling.rs:1676` / `1874`），于是"允许"和"拒绝"效果一样。
 */
const REPLIES = {
  'item/commandExecution/requestApproval': ['decision'],
  // 审批卡还读 params 里的 `kind`：`"command" | "writeStdin"`。
  // writeStdin 是往**已经在跑的进程**写输入，不是启动一条命令。
  'item/fileChange/requestApproval': ['decision'],
  'item/permissions/requestApproval': ['permissions', 'scope'],
  'item/tool/requestUserInput': ['answers'],
  'mcpServer/elicitation/request': ['action', 'content', '_meta'],
};

// ───────────────────────────── 解析内核 ─────────────────────────────

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...rustFiles(full));
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/**
 * 字段名与枚举变体名要分开转换，这是这个脚本第一版就写错的地方：
 * Rust 字段是 `snake_case`，变体是 `PascalCase`，**切词规则不一样**。
 * 拿 PascalCase 的切词正则去切 `thread_id`，只会匹配到 `Id`。
 */
function fieldWire(rustName, style) {
  const parts = rustName.split('_');
  if (!style || style === 'snake_case') return rustName;
  if (style === 'kebab-case') return parts.join('-');
  if (style === 'camelCase' || style === 'lowerCamelCase') {
    const [head, ...rest] = parts;
    return head + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  }
  if (style === 'PascalCase')
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (style === 'SCREAMING_SNAKE_CASE' || style === 'UPPERCASE') return rustName.toUpperCase();
  if (style === 'lowercase') return rustName.toLowerCase();
  return rustName;
}

function variantWire(pascalName, style) {
  if (!style) return pascalName;
  const words = (pascalName.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[0-9]+/g) ?? [pascalName]).map(
    (w) => w.toLowerCase(),
  );
  if (style === 'snake_case') return words.join('_');
  if (style === 'kebab-case') return words.join('-');
  if (style === 'camelCase' || style === 'lowerCamelCase')
    return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  if (style === 'PascalCase')
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (style === 'SCREAMING_SNAKE_CASE' || style === 'UPPERCASE')
    return words.join('_').toUpperCase();
  if (style === 'lowercase') return pascalName.toLowerCase();
  return pascalName;
}

/** 读结构体/枚举上方那一坨（跳过 doc 注释与空行）。 */
function attributesAbove(lines, index) {
  const attrs = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('#[') || line.startsWith(')]') || line.endsWith(',') || /^[A-Z]/.test(line))
      attrs.push(line);
    else break;
  }
  return attrs.join(' ');
}

function parseProtocol() {
  const structs = new Map();
  const enums = new Map();
  for (const file of rustFiles(PROTOCOL_SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const structMatch = /^pub struct (\w+)\s*\{/.exec(line);
      const enumMatch = /^pub enum (\w+)\s*\{/.exec(line);
      if (!structMatch && !enumMatch) {
        const unit = /^pub struct (\w+)\s*(\(|;)/.exec(line);
        if (unit) structs.set(unit[1], { fields: [], opaque: true });
        continue;
      }
      const attrs = attributesAbove(lines, i);
      const renameAll = /rename_all\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
      const containerDefault = /serde\([^)]*\bdefault\b/.test(attrs);
      // 取出 body
      let depth = 0;
      const body = [];
      for (let k = i; k < lines.length; k += 1) {
        depth += (lines[k].match(/\{/g) ?? []).length - (lines[k].match(/\}/g) ?? []).length;
        if (k > i) body.push(lines[k]);
        if (depth === 0 && k > i) break;
      }
      if (structMatch) {
        const fields = [];
        let pending = [];
        for (const raw of body) {
          const s = raw.trim();
          if (!s || s.startsWith('//')) continue;
          if (s.startsWith('#[') || (pending.length > 0 && !/^pub \w+\s*:/.test(s))) {
            pending.push(s);
            continue;
          }
          const fm = /^pub (\w+)\s*:\s*(.+?),?$/.exec(s);
          if (!fm) {
            pending = [];
            continue;
          }
          const [, name, type] = fm;
          const fieldAttrs = pending.join(' ');
          pending = [];
          if (/skip_deserializing|serde\(skip\)/.test(fieldAttrs)) continue;
          const rename = /\brename\s*=\s*"([^"]+)"/.exec(fieldAttrs)?.[1];
          const wire = rename ?? fieldWire(name, renameAll);
          const optional =
            type.startsWith('Option<') || /\bdefault\b/.test(fieldAttrs) || containerDefault;
          const flatten = fieldAttrs.includes('flatten');
          fields.push({ wire, required: !optional && !flatten, flatten });
        }
        structs.set(structMatch[1], { fields, opaque: false });
      } else {
        const variants = [];
        let pending = [];
        for (const raw of body) {
          const s = raw.trim();
          if (!s || s.startsWith('//')) continue;
          if (s.startsWith('#[')) {
            pending.push(s);
            continue;
          }
          const vm = /^([A-Z]\w*)\s*(\{|\(|,|$)/.exec(s);
          if (!vm) {
            pending = [];
            continue;
          }
          const variantAttrs = pending.join(' ');
          pending = [];
          const rename = /\brename\s*=\s*"([^"]+)"/.exec(variantAttrs)?.[1];
          variants.push(rename ?? variantWire(vm[1], renameAll));
        }
        enums.set(enumMatch[1], variants);
      }
    }
  }
  return { structs, enums };
}

/** 方法名 → 参数/响应结构体名。三张宏表（请求 / 服务端请求 / 通知）用的是同一种写法。 */
function parseMethodTables() {
  const common = readFileSync(join(PROTOCOL_SRC, 'protocol/common.rs'), 'utf8');
  const withBrace = /(\w+)\s*=>\s*"([^"]+)"\s*\{(.*?)\n {4}\}/gs;
  const requests = new Map();
  for (const m of common.matchAll(withBrace)) {
    const [, , method, body] = m;
    requests.set(method, {
      params: /params:\s*(?:#\[[^\]]*\]\s*)*(?:v2::)?(\w+)/.exec(body)?.[1],
      response: /response:\s*(?:v2::)?(\w+)/.exec(body)?.[1],
    });
  }
  const notifications = new Map();
  for (const m of common.matchAll(/(\w+)\s*=>\s*"([^"]+)"\s*\((?:v2::)?(\w+)\)/g)) {
    notifications.set(m[2], m[3]);
  }
  return { requests, notifications };
}

// ───────────────────────────── 比对 ─────────────────────────────

function fieldsOf(structs, name) {
  const found = structs.get(name);
  if (!found || found.opaque) return undefined;
  return found;
}

function checkOutgoing({ structs, enums, requests }, problems) {
  for (const [method, spec] of Object.entries(OUTGOING)) {
    const entry = requests.get(method);
    if (!entry) {
      problems.push({ method, kind: 'missing-method', detail: '内核没有这个方法了' });
      continue;
    }
    const struct = fieldsOf(structs, entry.params);
    if (!struct) continue; // 参数不是具名结构体（如 Option<()>），没有可比的字段
    const declared = new Set([
      ...(spec.keys ?? []),
      ...(spec.maybe === '*' ? [] : (spec.maybe ?? [])),
    ]);
    const known = new Set(struct.fields.map((f) => f.wire));
    const hasFlatten = struct.fields.some((f) => f.flatten);

    for (const field of struct.fields) {
      if (!field.required) continue;
      if ((spec.keys ?? []).includes(field.wire)) continue;
      if (spec.maybe === '*' || (spec.maybe ?? []).includes(field.wire)) {
        problems.push({
          method,
          kind: 'required-but-conditional',
          detail: `\`${field.wire}\` 是必填的，不能条件发送`,
        });
        continue;
      }
      problems.push({
        method,
        kind: 'missing-required',
        detail: `少发必填字段 \`${field.wire}\` → 内核在反序列化阶段打回 -32600`,
      });
    }
    if (!hasFlatten) {
      for (const key of declared) {
        if (!known.has(key)) {
          problems.push({ method, kind: 'unknown-field', detail: `内核没有 \`${key}\` 这个字段` });
        }
      }
    }
    for (const [field, literal] of Object.entries(spec.values ?? {})) {
      const type = entry.params && structs.get(entry.params);
      void type;
      const declaredType = rustTypeOf(structs, entry.params, field);
      const variants = declaredType && enums.get(declaredType);
      if (!variants) continue; // 不是枚举（String / bool），没有拼法可验
      for (const value of Array.isArray(literal) ? literal : [literal]) {
        if (!variants.includes(value)) {
          problems.push({
            method,
            kind: 'bad-enum-value',
            detail: `\`${field}: '${value}'\` 不是 ${declaredType} 的变体（内核只认 ${variants.join(' / ')}）`,
          });
        }
      }
    }
  }
}

/** 找到某个结构体某个字段的 Rust 类型名（剥掉 Option / Vec / Box）。 */
const RUST_TYPE_CACHE = new Map();
function rustTypeOf(structs, structName, wireField) {
  const key = `${structName}.${wireField}`;
  if (RUST_TYPE_CACHE.has(key)) return RUST_TYPE_CACHE.get(key);
  let found;
  for (const file of rustFiles(PROTOCOL_SRC)) {
    const text = readFileSync(file, 'utf8');
    const at = text.indexOf(`pub struct ${structName} {`);
    if (at < 0) continue;
    const body = text.slice(at, text.indexOf('\n}', at));
    const snake = wireField.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const fm = new RegExp(`pub (?:${wireField}|${snake})\\s*:\\s*([^,\\n]+)`).exec(body);
    if (fm) found = fm[1].replace(/Option<|Vec<|Box<|>/g, '').trim();
    break;
  }
  RUST_TYPE_CACHE.set(key, found);
  return found;
}

function checkIncoming({ structs, notifications }, problems) {
  for (const [method, reads] of Object.entries(INCOMING)) {
    const structName = notifications.get(method);
    if (!structName) {
      problems.push({ method, kind: 'missing-notification', detail: '内核不再发这条通知' });
      continue;
    }
    const struct = fieldsOf(structs, structName);
    if (!struct) continue;
    const known = new Set(struct.fields.map((f) => f.wire));
    for (const field of reads) {
      if (!known.has(field)) {
        problems.push({
          method,
          kind: 'unknown-field',
          detail: `读了内核不发的 \`${field}\` —— 它恒为 undefined，而且不报错`,
        });
      }
    }
  }
}

function checkReplies({ structs, requests }, problems) {
  for (const [method, sends] of Object.entries(REPLIES)) {
    const entry = requests.get(method);
    if (!entry) {
      problems.push({ method, kind: 'missing-method', detail: '内核不再发这个请求' });
      continue;
    }
    const struct = fieldsOf(structs, entry.response);
    if (!struct) continue;
    const known = new Set(struct.fields.map((f) => f.wire));
    const hasFlatten = struct.fields.some((f) => f.flatten);
    for (const field of struct.fields) {
      if (field.required && !sends.includes(field.wire)) {
        problems.push({
          method,
          kind: 'missing-required',
          detail: `回复少了必填字段 \`${field.wire}\` —— 内核**不报错**，会兜一个默认值`,
        });
      }
    }
    if (hasFlatten) continue;
    for (const field of sends) {
      if (!known.has(field)) {
        problems.push({ method, kind: 'unknown-field', detail: `回复里的 \`${field}\` 内核不认` });
      }
    }
  }
}

/** 我们从服务端请求的 params 里读的字段，内核到底发不发。 */
function checkRequestReads({ structs, requests }, problems) {
  for (const [method, reads] of Object.entries(REQUEST_READS)) {
    const entry = requests.get(method);
    if (!entry) continue; // checkReplies 已经报过「方法没了」
    const struct = fieldsOf(structs, entry.params);
    if (!struct) continue;
    if (struct.fields.some((f) => f.flatten)) continue; // flatten 展开的字段这里看不全
    const known = new Set(struct.fields.map((f) => f.wire));
    for (const field of reads) {
      if (!known.has(field)) {
        problems.push({
          method,
          kind: 'unknown-field',
          detail: `读了内核不发的 \`${field}\` —— 恒为 undefined，而且不报错`,
        });
      }
    }
  }
}

/**
 * 适配层里**真的会发出去**、但这张表没登记的方法。少一条就失败 ——
 * 否则表会慢慢和代码脱节，而那正是这个脚本要防的事。
 *
 * 只认调用点（`request(METHOD.x` / `callExperimental(METHOD.x`），**不认单纯提到常量**：
 * `capabilities.ts` 的降级表把每个实验方法都列了一遍，那不是调用。
 */
function callSites() {
  const adapterDir = join(REPO_ROOT, 'services/kernel-adapter/src');
  const names = new Set();
  const call =
    /(?:\.request|callExperimental)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:METHOD|EXPERIMENTAL_METHOD)\.(\w+)/g;
  for (const file of readdirSync(adapterDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(adapterDir, file), 'utf8');
    for (const m of text.matchAll(call)) names.add(m[1]);
  }
  return names;
}

function checkCoverage(methodConstants, problems) {
  const used = new Set();
  for (const name of callSites()) {
    const wire = methodConstants.get(name);
    if (wire) used.add(wire);
  }
  for (const method of used) {
    if (method in OUTGOING || method in OUTGOING_EXEMPT) continue;
    problems.push({
      method,
      kind: 'unregistered',
      detail: '适配层在调它，但 scripts/kernel-contract.mjs 的 OUTGOING 里没有登记',
    });
  }
}

function methodConstants() {
  const text = readFileSync(join(REPO_ROOT, 'packages/protocol/src/methods.ts'), 'utf8');
  return new Map([...text.matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
}

// ───────────────────────────── 主流程 ─────────────────────────────

function main() {
  const json = process.argv.includes('--json');
  if (!existsSync(PROTOCOL_SRC)) {
    // 本地没签出内核不算失败：CI 与开发机都能跑，但开发机上内核目录是可选的。
    const note = `跳过：读不到内核协议源码（${PROTOCOL_SRC}）。用 EVOWORK_KERNEL_DIR 指定。`;
    console.log(json ? JSON.stringify({ skipped: true, note }) : `⚠️  ${note}`);
    process.exit(0);
  }

  const { structs, enums } = parseProtocol();
  const { requests, notifications } = parseMethodTables();
  const problems = [];
  checkOutgoing({ structs, enums, requests }, problems);
  checkIncoming({ structs, notifications }, problems);
  checkReplies({ structs, requests }, problems);
  checkRequestReads({ structs, requests }, problems);
  checkCoverage(methodConstants(), problems);

  if (json) {
    console.log(JSON.stringify({ problems, checked: Object.keys(OUTGOING).length }, null, 2));
  } else {
    console.log('\n# 协议形状自检（K2）\n');
    console.log(
      `请求 ${Object.keys(OUTGOING).length} 个 · 通知 ${Object.keys(INCOMING).length} 条 · ` +
        `回复 ${Object.keys(REPLIES).length} 个 · 内核结构体 ${structs.size} 个\n`,
    );
    if (problems.length === 0) {
      console.log('✅ 我们发的形状和内核接受的形状一致。\n');
    } else {
      console.log(`❌ ${problems.length} 处对不上：\n`);
      for (const p of problems) console.log(`  - **${p.method}** (${p.kind})：${p.detail}`);
      console.log(
        '\n这一类缺陷的代价是**发现不了**：要么是一个裸 -32600，要么内核根本不报错、' +
          '兜个默认值继续跑。别把它当成"改个字段名"，先看清楚它在用户那边长什么样。\n',
      );
    }
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

main();
