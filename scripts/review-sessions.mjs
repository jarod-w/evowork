#!/usr/bin/env node
/**
 * **本机会话复盘**：读本机内核的会话记录，看 agent 实际用起来怎么样。
 *
 * 2026-10-22 第一次手工做这件事，10 个真实会话里挖出的问题比所有测试加起来都多：
 * 技能读不到自己的参考文件、agent 去逆向 App 安装包、同一份 SKILL.md 装了三次、
 * 记忆把产品注入的话当成用户原话、长任务上下文滚到 196K。这些都不报错 —— 只有看会话才看得见。
 * 这个脚本把那次的做法固化下来：改完 Craft 指令、技能、网关之后跑一遍，看数字有没有变好。
 *
 * **K2 说明**：会话记录（rollout）是内核的内部格式，不是契约。产品代码一律不许读它；
 * 这是开发工具（scripts/ 不受那条 lint 约束），解析时对认不出的记录只计数、不报错，
 * 认不出的种类会列在报告末尾 —— 那一栏变多，就是上游改了格式、这里该跟着改了。
 *
 * **隐私**：默认**不输出任何对话原文**（用户请求、回复、路径都不出现）；判断「同一请求反复出现」
 * 只比哈希。要看原文加 `--with-text`，报告就含了任务内容，别外传。
 *
 * 用法：
 *   node scripts/review-sessions.mjs                         # ~/.evowork 下的全部会话
 *   node scripts/review-sessions.mjs --since 2026-10-20      # 只看某天之后开始的
 *   node scripts/review-sessions.mjs --with-text             # 带上请求摘录（只给自己看）
 *   node scripts/review-sessions.mjs --json report.json      # 另存机器可读结果
 *   EVOWORK_HOME=<目录> node scripts/review-sessions.mjs      # 换一个数据目录
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 认得的记录种类；其余只计数（见头注释） */
const KNOWN_TYPES = new Set([
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'token_usage_record',
  'world_state',
  'compacted',
]);

/** 产品自动注入、不是用户原话的文本（附件说明新旧两版）。出现在记忆里就是记错了来源 */
export const INJECTED_PHRASES = ['不要让我把全文贴出来', '需要细节时直接读那个文件', '【附件说明'];

const BRAND = /\b(Codex|OpenAI|ChatGPT)\b|CODEX_HOME/;
const HEAVY_CONTEXT = 100_000;
const MANY_IMAGES = 5;

/** 一条 shell 命令踩了哪些值得复盘的模式 */
export function commandFlags(cmd) {
  const flags = [];
  const text = String(cmd);
  // 读随包技能是正常的；翻安装包里别的东西（压缩过的 JS、Resources 下的产物）是在逆向产品
  if (/\/Applications\/EvoWork\.app\b/.test(text) && !/\/plugins\/skills\//.test(text))
    flags.push('inspect-app-bundle');
  // ~/.evowork 下：工作区、技能（含内核那份）、记忆、办公运行时是正常用法 —— 内核亲口把技能与
  // 记忆的路径告诉模型（10 §2.3 的放行口子）；其余是产品内部状态
  for (const match of text.matchAll(/(?:~|\$HOME|\/Users\/[^/\s]+)\/\.evowork\/([^\s"';|&]*)/g)) {
    const rest = match[1] ?? '';
    if (!/^(workspaces|skills|runtime|kernel\/skills|kernel\/memories)(\/|$)/.test(rest)) {
      flags.push('inspect-app-state');
      break;
    }
  }
  if (/\bfind\s+\/(?:\s|$)/.test(text) || /\b(mdfind|locate)\s/.test(text))
    flags.push('disk-wide-search');
  // 中间文件：建在系统临时目录是期望的写法；建在工作区里的隐藏/临时目录会混进交付物
  if (/(?:^|[\s;&|=>"'(])(?:\/tmp\/|\$TMPDIR|\$\{TMPDIR)/.test(text)) flags.push('scratch-in-tmp');
  if (
    /\bmkdir\b[^;&|]*?(?:^|[\s/])(\.build|\.qa[\w-]*|\.tmp|tmp|scratch|_build)(?:[\s/]|$)/.test(
      text,
    ) &&
    !/\bmkdir\b[^;&|]*?(?:\/tmp\/|\$TMPDIR|\$\{TMPDIR)/.test(text)
  )
    flags.push('scratch-in-workspace');
  if (/\b(curl|wget)\b/.test(text)) flags.push('network-command');
  return flags;
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n');
}

function hashAsk(text) {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return normalized ? createHash('sha256').update(normalized).digest('hex').slice(0, 10) : '';
}

function exitCodeOf(output) {
  const match =
    /Process exited with code (\d+)/.exec(output) ?? /"exit_code"\s*:\s*(\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** 一个会话文件 → 结构化摘要。`records` 是逐行 JSON.parse 的结果 */
export function summarizeRollout(records) {
  const session = {
    id: '',
    startedAt: '',
    cwd: '',
    turns: [],
    unknownTypes: {},
    /** 会话里各类内容的字符数（粗略的上下文构成；图片按 0 计 —— DeepSeek 一张图只计 1–2K token） */
    composition: { reasoning: 0, toolCalls: 0, fileReads: 0, otherOutputs: 0, messages: 0 },
  };
  let turn;
  const calls = new Map();
  for (const record of records) {
    const type = record?.type;
    const payload = record?.payload ?? {};
    if (!KNOWN_TYPES.has(type)) {
      session.unknownTypes[type] = (session.unknownTypes[type] ?? 0) + 1;
      continue;
    }
    if (type === 'session_meta') {
      session.id = payload.id ?? payload.session_id ?? '';
      session.startedAt = payload.timestamp ?? record.timestamp ?? '';
      session.cwd = payload.cwd ?? '';
      continue;
    }
    if (type === 'event_msg' && payload.type === 'task_started') {
      turn = {
        startedAt: record.timestamp ?? '',
        durationMs: undefined,
        status: 'running',
        errorCode: undefined,
        model: undefined,
        sandbox: undefined,
        ask: '',
        askHash: '',
        attachmentNote: false,
        attachments: [],
        requests: 0,
        input: 0,
        cached: 0,
        output: 0,
        peakContext: 0,
        tools: {},
        failedTools: 0,
        blocked: [],
        viewImages: 0,
        flags: {},
        finalMessage: '',
      };
      session.turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (type === 'turn_context') {
      turn.model = payload.model ?? turn.model;
      turn.sandbox = payload.sandbox_policy?.type ?? turn.sandbox;
      continue;
    }
    if (type === 'event_msg') {
      if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage' && !turn.ask) {
        const parts = Array.isArray(payload.item.content) ? payload.item.content : [];
        const texts = parts.map((part) => (typeof part?.text === 'string' ? part.text : ''));
        turn.attachmentNote = texts.some((t) => INJECTED_PHRASES.some((p) => t.includes(p)));
        // 附件文件名（新旧两版附件说明都写成《名字》）只留哈希：同一个附件出现在几个会话里，
        // 往往是同一件事做了好几遍 —— 10-07/08 那份 SKILL.md 三次说法都不同，按请求原文比不出来
        turn.attachments = texts
          .filter((t) => INJECTED_PHRASES.some((p) => t.includes(p)))
          .flatMap((t) =>
            [...t.matchAll(/(?:已上传|上传了)《([^》]+)》/g)].map((m) => hashAsk(m[1] ?? '')),
          )
          .filter(Boolean);
        // 用户自己的话：去掉产品注入的附件说明那一段
        turn.ask = texts.filter((t) => !INJECTED_PHRASES.some((p) => t.includes(p))).join('\n');
        turn.askHash = hashAsk(turn.ask);
      } else if (payload.type === 'token_count' && payload.info) {
        const last = payload.info.last_token_usage ?? {};
        turn.requests += 1;
        turn.input += last.input_tokens ?? 0;
        turn.cached += last.cached_input_tokens ?? 0;
        turn.output += last.output_tokens ?? 0;
        turn.peakContext = Math.max(turn.peakContext, last.input_tokens ?? 0);
      } else if (payload.type === 'task_complete') {
        turn.durationMs = payload.duration_ms;
        turn.finalMessage = payload.last_agent_message ?? turn.finalMessage;
        turn.status = payload.error ? 'failed' : 'completed';
        turn.errorCode = payload.error?.codex_error_info ?? undefined;
      } else if (payload.type === 'turn_aborted') {
        turn.durationMs = payload.duration_ms;
        turn.status = 'interrupted';
        turn.errorCode = payload.reason;
      }
      continue;
    }
    if (type !== 'response_item') continue;
    if (payload.type === 'reasoning') {
      session.composition.reasoning +=
        textOf(payload.content).length + textOf(payload.summary).length;
    } else if (payload.type === 'message') {
      session.composition.messages += textOf(payload.content).length;
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = textOf(payload.content);
      if (text) turn.finalMessage = text;
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      session.composition.toolCalls += String(payload.arguments ?? payload.input ?? '').length;
      const name = payload.name ?? payload.type;
      turn.tools[name] = (turn.tools[name] ?? 0) + 1;
      if (name === 'view_image') turn.viewImages += 1;
      let cmd = '';
      try {
        const args = JSON.parse(payload.arguments ?? '{}');
        cmd = args.cmd ?? args.command ?? '';
        if (Array.isArray(cmd)) cmd = cmd.join(' ');
      } catch {
        cmd = typeof payload.input === 'string' ? payload.input : '';
      }
      calls.set(payload.call_id, { name, cmd });
      for (const flag of commandFlags(cmd)) turn.flags[flag] = (turn.flags[flag] ?? 0) + 1;
    } else if (
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output'
    ) {
      const output =
        typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      const textual = Array.isArray(payload.output)
        ? textOf(payload.output.filter((part) => part?.type !== 'input_image')).length
        : output.length;
      const source = calls.get(payload.call_id)?.cmd ?? '';
      if (/^\s*(cat|sed -n|head|tail|less|nl)\b/.test(source) || /[;&|]\s*cat\s/.test(source))
        session.composition.fileReads += textual;
      else session.composition.otherOutputs += textual;
      if (output.includes('Command blocked by PreToolUse hook')) {
        // 只留拦截理由（「这是 EvoWork 自己的配置」一类），不留路径：路径在第一个全角冒号之前
        const reason =
          /Command blocked by PreToolUse hook: [^：]*：([^，。,]+)/.exec(output)?.[1]?.trim() ??
          '策略拦截';
        turn.blocked.push(reason);
      } else if ((exitCodeOf(output) ?? 0) !== 0) {
        turn.failedTools += 1;
      }
    }
  }
  for (const t of session.turns) {
    if (t.status === 'running') t.status = 'unfinished';
    if (BRAND.test(t.finalMessage)) t.flags['brand-in-reply'] = 1;
    if (t.peakContext > HEAVY_CONTEXT) t.flags['heavy-context'] = 1;
    if (t.viewImages >= MANY_IMAGES) t.flags['many-images'] = 1;
    if (/^继续完成这个任务/.test(t.ask)) t.flags['resume-after-stop'] = 1;
  }
  return session;
}

/** 记忆文件里有没有把产品注入的话当成内容记下来 */
export function memoryFindings(memoryDir) {
  const findings = [];
  for (const name of ['memory_summary.md', 'MEMORY.md', 'raw_memories.md']) {
    const path = join(memoryDir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const phrase of INJECTED_PHRASES) {
      const count = text.split(phrase).length - 1;
      if (count > 0) findings.push({ file: name, phrase, count });
    }
  }
  return findings;
}

const PATTERNS = [
  ['policy-block', '命令被策略拦下', '技能/记忆读不到、或 agent 在试探受保护路径'],
  ['inspect-app-bundle', '翻 App 安装包', 'agent 在逆向产品而不是做任务（缺产品自身说明）'],
  ['inspect-app-state', '翻 ~/.evowork 内部状态', '同上'],
  ['disk-wide-search', '全盘搜索（find / 等）', '找不到东西时的兜底，慢且噪'],
  ['scratch-in-workspace', '在工作区里建临时目录', '中间文件混进用户目录或交付物'],
  ['scratch-in-tmp', '中间文件放系统临时目录', '期望的写法（计数用来看改进有没有被采纳）'],
  ['heavy-context', `单次请求上下文 > ${HEAVY_CONTEXT / 1000}K`, '长任务上下文膨胀'],
  ['many-images', `一个回合看图 ≥ ${MANY_IMAGES} 张`, '图片留在上下文里，越滚越大'],
  ['brand-in-reply', '回复里出现内核品牌词', 'K5'],
  ['resume-after-stop', '用户点了「继续完成这个任务」', '前一回合被打断'],
  ['network-command', '用 curl / wget 直接联网', '信息'],
];

/** 全部会话 → 汇总（纯函数，测试直接用） */
export function analyze(sessions) {
  const turns = sessions.flatMap((s) =>
    s.turns.map((t, i) => ({ ...t, session: s.id, index: i + 1 })),
  );
  const totals = {
    sessions: sessions.length,
    turns: turns.length,
    models: [...new Set(turns.map((t) => t.model).filter(Boolean))],
    requests: turns.reduce((n, t) => n + t.requests, 0),
    input: turns.reduce((n, t) => n + t.input, 0),
    cached: turns.reduce((n, t) => n + t.cached, 0),
    output: turns.reduce((n, t) => n + t.output, 0),
    peakContext: Math.max(0, ...turns.map((t) => t.peakContext)),
    status: {},
    errors: {},
    sandbox: {},
  };
  for (const t of turns) {
    totals.status[t.status] = (totals.status[t.status] ?? 0) + 1;
    if (t.errorCode) totals.errors[t.errorCode] = (totals.errors[t.errorCode] ?? 0) + 1;
    if (t.sandbox) totals.sandbox[t.sandbox] = (totals.sandbox[t.sandbox] ?? 0) + 1;
  }
  const patterns = PATTERNS.map(([key, label, why]) => {
    const hits = turns.filter((t) => (key === 'policy-block' ? t.blocked.length : t.flags[key]));
    const count = hits.reduce(
      (n, t) => n + (key === 'policy-block' ? t.blocked.length : t.flags[key]),
      0,
    );
    return {
      key,
      label,
      why,
      count,
      turns: hits.map((t) => `${t.session.slice(0, 8)}#${t.index}`),
    };
  });
  const blockedReasons = {};
  for (const t of turns)
    for (const r of t.blocked) blockedReasons[r] = (blockedReasons[r] ?? 0) + 1;
  // 同一句请求出现在不止一个会话里：多半是上一次没办成
  const byAsk = new Map();
  for (const t of turns) {
    if (!t.askHash || t.flags['resume-after-stop']) continue;
    const entry = byAsk.get(t.askHash) ?? { hash: t.askHash, ask: t.ask, sessions: new Set() };
    entry.sessions.add(t.session);
    byAsk.set(t.askHash, entry);
  }
  const repeated = [...byAsk.values()]
    .filter((e) => e.sessions.size > 1)
    .map((e) => ({
      hash: e.hash,
      ask: e.ask,
      sessions: [...e.sessions].map((s) => s.slice(0, 8)),
    }));
  const byAttachment = new Map();
  for (const t of turns)
    for (const hash of t.attachments ?? []) {
      const sessionsWith = byAttachment.get(hash) ?? new Set();
      sessionsWith.add(t.session);
      byAttachment.set(hash, sessionsWith);
    }
  const repeatedAttachments = [...byAttachment]
    .filter(([, sessionsWith]) => sessionsWith.size > 1)
    .map(([hash, sessionsWith]) => ({
      hash,
      sessions: [...sessionsWith].map((s) => s.slice(0, 8)),
    }));
  const unknownTypes = {};
  for (const s of sessions)
    for (const [k, v] of Object.entries(s.unknownTypes))
      unknownTypes[k] = (unknownTypes[k] ?? 0) + v;
  const composition = { reasoning: 0, toolCalls: 0, fileReads: 0, otherOutputs: 0, messages: 0 };
  for (const s of sessions)
    for (const [key, value] of Object.entries(s.composition ?? {}))
      composition[key] = (composition[key] ?? 0) + value;
  return {
    totals,
    patterns,
    blockedReasons,
    repeated,
    repeatedAttachments,
    turns,
    unknownTypes,
    composition,
  };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n));
const sec = (ms) => (ms === undefined ? '—' : `${Math.round(ms / 1000)}s`);

export function renderMarkdown(report, { withText = false, memory = [], scope = '' } = {}) {
  const { totals, patterns, blockedReasons, repeated, repeatedAttachments, turns, unknownTypes } =
    report;
  const cacheRate = totals.input ? Math.round((totals.cached / totals.input) * 100) : 0;
  const lines = [
    '# 本机会话复盘',
    '',
    `${scope}${withText ? '' : '（不含对话原文；加 `--with-text` 可看请求摘录）'}`,
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 会话 / 回合 | ${totals.sessions} / ${totals.turns} |`,
    `| 模型 | ${totals.models.join('、') || '—'} |`,
    `| 回合结局 | ${Object.entries(totals.status)
      .map(([s, n]) => `${s} ${n}`)
      .join(' · ')} |`,
    `| 错误码 | ${
      Object.entries(totals.errors)
        .map(([s, n]) => `${s} ${n}`)
        .join(' · ') || '无'
    } |`,
    `| 权限档 | ${
      Object.entries(totals.sandbox)
        .map(([s, n]) => `${s} ${n}`)
        .join(' · ') || '—'
    } |`,
    `| 模型请求 | ${totals.requests} 次 |`,
    `| 输入 / 缓存命中 / 输出 token | ${k(totals.input)} / ${k(totals.cached)}（${cacheRate}%）/ ${k(totals.output)} |`,
    `| 单次请求上下文峰值 | ${k(totals.peakContext)} |`,
    '',
    '## 值得看的模式',
    '',
    '| 模式 | 次数 | 涉及回合 | 说明 |',
    '| --- | --- | --- | --- |',
    ...patterns.map(
      (p) =>
        `| ${p.label} | ${p.count} | ${p.turns.slice(0, 6).join(' ') || '—'}${p.turns.length > 6 ? ' …' : ''} | ${p.why} |`,
    ),
  ];
  if (Object.keys(blockedReasons).length > 0) {
    lines.push(
      '',
      '策略拦截理由：' +
        Object.entries(blockedReasons)
          .map(([r, n]) => `「${r}」×${n}`)
          .join('、'),
    );
  }
  lines.push('', '## 同一件事在多个会话里重复出现', '');
  const attachmentLines = (repeatedAttachments ?? []).map(
    (r) =>
      `- 同一个附件（${r.hash}）出现在 ${r.sessions.length} 个会话里（${r.sessions.join(' ')}）`,
  );
  lines.push(
    repeated.length === 0 && attachmentLines.length === 0
      ? '无。'
      : [
          ...attachmentLines,
          ...repeated.map(
            (r) =>
              `- ${withText ? `「${r.ask.replace(/\s+/g, ' ').slice(0, 60)}」` : `请求 ${r.hash}`}：${r.sessions.length} 个会话（${r.sessions.join(' ')}）`,
          ),
        ].join('\n'),
  );
  if (report.composition) {
    const parts = [
      ['推理（思维链）', report.composition.reasoning],
      ['工具调用参数（含模型写的脚本）', report.composition.toolCalls],
      ['读文件的输出', report.composition.fileReads],
      ['其他工具输出', report.composition.otherOutputs],
      ['消息', report.composition.messages],
    ];
    const all = parts.reduce((n, [, v]) => n + v, 0) || 1;
    lines.push(
      '',
      '## 上下文构成（按字符粗算，截图不计）',
      '',
      '| 来源 | 字符 | 占比 |',
      '| --- | --- | --- |',
      ...parts.map(([label, v]) => `| ${label} | ${k(v)} | ${Math.round((v / all) * 100)}% |`),
    );
  }
  lines.push('', '## 记忆里的产品注入文本', '');
  lines.push(
    memory.length === 0
      ? '无（或没有记忆文件）。'
      : memory.map((m) => `- ${m.file}：「${m.phrase}」×${m.count}`).join('\n'),
  );
  lines.push(
    '',
    '## 逐回合',
    '',
    `| 回合 | 结局 | 用时 | 请求 | 峰值上下文 | 工具调用 | 失败 / 拦截 | 看图 |${withText ? ' 请求摘录 |' : ''}`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |${withText ? ' --- |' : ''}`,
    ...turns.map((t) => {
      const tools = Object.values(t.tools).reduce((n, v) => n + v, 0);
      const ask = withText
        ? ` ${t.ask.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 40)} |`
        : '';
      return `| ${t.session.slice(0, 8)}#${t.index} | ${t.status}${t.errorCode ? `（${t.errorCode}）` : ''} | ${sec(t.durationMs)} | ${t.requests} | ${k(t.peakContext)} | ${tools} | ${t.failedTools} / ${t.blocked.length} | ${t.viewImages} |${ask}`;
    }),
  );
  const unknown = Object.entries(unknownTypes);
  lines.push(
    '',
    `认不出的记录种类：${unknown.length ? unknown.map(([t, n]) => `${t} ×${n}`).join('、') + ' —— 内核可能改了会话格式，脚本该跟着改' : '无'}`,
  );
  return lines.join('\n');
}

function rolloutFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((name) => join(dir, String(name)))
    .filter((path) => path.endsWith('.jsonl') && statSync(path).isFile())
    .sort();
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const withText = argv.includes('--with-text');
  const since = flag('--since');
  const home = process.env.EVOWORK_HOME ?? join(homedir(), '.evowork');
  const dir = flag('--dir') ?? join(home, 'kernel/sessions');
  const files = rolloutFiles(dir);
  if (files.length === 0) {
    console.error(`没有找到会话记录：${dir}`);
    process.exit(2);
  }
  const sessions = [];
  for (const file of files) {
    const records = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* 半行（内核正在写）跳过 */
      }
    }
    const session = summarizeRollout(records);
    if (since && session.startedAt && session.startedAt.slice(0, 10) < since) continue;
    sessions.push(session);
  }
  const report = analyze(sessions);
  const memory = memoryFindings(join(home, 'kernel/memories'));
  console.log(
    renderMarkdown(report, {
      withText,
      memory,
      scope: `数据目录：${withText ? dir : '（本机）'}${since ? `，${since} 起` : ''}。`,
    }),
  );
  const jsonPath = flag('--json');
  if (jsonPath) {
    const strip = (t) => (withText ? t : { ...t, ask: undefined, finalMessage: undefined });
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          ...report,
          turns: report.turns.map(strip),
          repeated: report.repeated.map((r) => (withText ? r : { ...r, ask: undefined })),
          memory,
        },
        null,
        2,
      ),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
