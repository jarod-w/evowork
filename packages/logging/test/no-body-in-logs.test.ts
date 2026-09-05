/**
 * 09 §8 明写的那条 CI 断言：
 *
 *   > 配套一个 CI 测试：跑一次真实任务，断言日志与 trace 里不出现输入文本的任何 8 字以上片段。
 *
 * 这里跑的是**结构等价的仿真任务**，不是真实模型调用 —— 真实调用要等 P0-4 的 API key
 * （见 work-priority §10 的 U2）。但被覆盖的路径是真实的那三条（Q14 原话）：
 * 应用日志、APM trace 的 span attribute、错误上报。
 *
 * 这个测试的价值在于它**会红**：任何人日后加一个"临时打印一下 prompt"的埋点，
 * 只要那个埋点复用了本包，测试就会指出泄露片段与位置。
 */
import { describe, expect, it } from 'vitest';

import { assertNoLeak, findLeaks, LeakDetected } from '../src/leak-detector.js';
import { createLogger, formatJsonLine, memorySink, type LogRecord } from '../src/logger.js';
import { digest, errorFields, pathFields } from '../src/redact.js';

/** 一次真实办公任务的输入面：用户指令、上传文件名、以及模型返回的正文。 */
const TASK = {
  prompt:
    '把 data/ 下的三张表合并，按季度对比毛利率，生成一份 8 页的季度汇报 pptx，重点讲鹏程公司的欠款风险',
  uploadPath: '/Users/x/work/weekly/uploads/20260905-093012-q2/鹏程公司-2026Q2-逾期清单.xlsx',
  modelReply:
    '好的，我先读取三张表的表头，然后按季度分组计算毛利率，最后套用 business 模板生成幻灯片。',
  /** 上游把请求 echo 回来的错误消息 —— 最常见的泄露形态 */
  upstreamError: `400 invalid_request_error: {"model":"glm-5.3-flash","messages":[{"role":"user","content":"${'把 data/ 下的三张表合并，按季度对比毛利率'}"}]}`,
};

const SECRETS = [TASK.prompt, TASK.uploadPath, TASK.modelReply];

/** 仿真的 APM 导出：span 只允许带与日志同一批字段（Q14 对 trace 的要求） */
function exportSpans(records: readonly LogRecord[]): string {
  return JSON.stringify(
    records.map((r) => ({
      name: r.event,
      startTime: r.ts,
      attributes: r.fields,
    })),
  );
}

/** 仿真的崩溃上报：只允许带 errorFields 的产出（Q14：堆栈不得携带请求体） */
function crashReport(err: unknown, context: Record<string, unknown>): string {
  return JSON.stringify({ ...errorFields(err), ...context });
}

describe('三条会泄露正文的路径都不带正文（Q14 / 09 §8 / 10 §6）', () => {
  it('一次仿真任务跑完，日志 · trace · 错误上报三处都查不到输入文本的 8 字片段', () => {
    const sink = memorySink();
    const log = createLogger({
      service: 'gateway',
      level: 'debug',
      sink,
      base: { appVersion: '0.0.0', provider: 'zhipu', model: 'glm-5.3-flash' },
    });

    const workspaceRoots = ['/Users/x/work/weekly'];

    // ① 收到任务：想记 prompt 的冲动落在 promptDigest 上
    const req = log.child({ requestId: 'req-20260905-01', threadId: 'thread_01JQ' });
    req.info('gateway.request.started', {
      method: 'turn/start',
      promptDigest: digest(TASK.prompt),
      messageLength: TASK.prompt.length,
      scenarioId: 'office',
      mode: 'craft',
      permissionProfile: 'evowork-workspace',
    });

    // ② 上传文件：只记类别 + 摘要 + 扩展名
    req.info('ingest.file.parsed', {
      ...pathFields(TASK.uploadPath, { workspaceRoots }),
      pageCount: 12,
      rowCount: 843,
      durationMs: 4210,
    });

    // ③ 流式响应：只记事件种类与计量
    req.debug('gateway.stream.first_token', { ttfbMs: 903, streamEventKind: 'response.created' });
    req.info('gateway.request.completed', {
      statusCode: 200,
      tokensIn: 2143,
      tokensOut: 1877,
      tokensCached: 0,
      cacheHit: false,
      degraded: true,
      degradeReason: 'NO_REASONING',
      durationMs: 18422,
    });

    // ④ 上游报错：错误消息里带着请求体
    const err = new Error(TASK.upstreamError);
    req.error('gateway.request.failed', { ...errorFields(err), statusCode: 400, retryCount: 1 });

    // ⑤ 产物落地：文件名同样不记
    req.info('artifacts.recognized', {
      artifactId: 'art_01JQ',
      ...pathFields('/Users/x/work/weekly/季度汇报-鹏程.pptx', { workspaceRoots }),
      reason: 'SKILL_REPORT',
      byteSize: 2_411_233,
    });

    const logText = sink.text();
    const traceText = exportSpans(sink.records);
    const crashText = crashReport(err, { requestId: 'req-20260905-01', service: 'gateway' });

    assertNoLeak(logText, SECRETS, '本机日志');
    assertNoLeak(traceText, SECRETS, 'APM trace span attribute');
    assertNoLeak(crashText, SECRETS, '崩溃上报');

    // 反面：该记的确实记下来了，不是靠"什么都不记"通过的
    expect(logText).toContain('"tokensIn":2143');
    expect(logText).toContain('"degradeReason":"NO_REASONING"');
    expect(logText).toContain('"pathKind":"upload"');
    expect(logText).toContain('"errorClass":"Error"');
    expect(sink.records).toHaveLength(6);
  });

  it('反例验证：真有人把正文塞进去时，断言必须变红', () => {
    // 用 drop 模式模拟"生产环境 + 有人加了个自由字段"——字段被丢掉，所以仍然不泄露
    const dropSink = memorySink();
    const dropLog = createLogger({ service: 'gateway', sink: dropSink, onViolation: 'drop' });
    dropLog.info('gateway.request.started', { prompt: TASK.prompt });
    expect(() => assertNoLeak(dropSink.text(), SECRETS)).not.toThrow();

    // 而如果绕过本包直接手写一行日志，检测器必须抓到它 —— 这是这条断言的真实用途：
    // 它不只测本包，它测的是「最终写到磁盘上的那些字节」
    const handRolled = JSON.stringify({
      ts: '2026-09-05T01:00:00.000Z',
      level: 'info',
      event: 'gateway.request.started',
      // 有人"就这一次"把 prompt 打了出来
      note: `user asked: ${TASK.prompt}`,
    });
    expect(() => assertNoLeak(handRolled, SECRETS, '手写日志行')).toThrow(LeakDetected);
    try {
      assertNoLeak(handRolled, SECRETS, '手写日志行');
    } catch (e) {
      expect(String(e)).toContain('手写日志行');
      // 报错要指出命中的片段，否则排查时不知道漏的是哪一段
      expect((e as LeakDetected).leaks[0]?.gram.length).toBe(8);
    }
  });

  it('JSON 转义之后的泄露也要抓到（最常见的形态）', () => {
    const escaped = JSON.stringify({ msg: `line1\n${TASK.modelReply}\tline3` });
    expect(findLeaks(escaped, TASK.modelReply).length).toBeGreaterThan(0);
  });

  it('不误报：短字符串与无关内容不算泄露', () => {
    const log = JSON.stringify({ event: 'gateway.request.completed', tokensIn: 2143 });
    expect(findLeaks(log, '毛利率')).toEqual([]); // 短于 8 字
    expect(findLeaks(log, TASK.prompt)).toEqual([]);
  });

  it('不误报：时间戳撞车不算泄露（这条断言最大的误报源）', () => {
    // 上传目录名带时间戳，而同一条日志合法地记着同一天的 requestId ——
    // 两者共享 8 个字符 "20260905"，但那只是同一天，不是泄露
    const log = JSON.stringify({ requestId: 'req-20260905-01', pathKind: 'upload' });
    const uploadPath = '/w/uploads/20260905-093012-q2/original.xlsx';
    expect(findLeaks(log, uploadPath)).toEqual([]);

    // 但"纯数字也可能就是秘密本身"（金额、账号），所以这一档是可显式打开的
    const amountLog = JSON.stringify({ note: 'balance 128400000 CNY' });
    expect(
      findLeaks(amountLog, '欠款 128400000 元', { includeNumericGrams: true }).length,
    ).toBeGreaterThan(0);
    expect(findLeaks(amountLog, '欠款 128400000 元')).toEqual([]);
  });

  it('滑窗长度可调，8 字是 09 §8 的默认口径', () => {
    const text = '按季度对比毛利率';
    const haystack = JSON.stringify({ note: `xx${text}yy` });
    expect(findLeaks(haystack, text, { minGram: 8 }).length).toBe(1);
    expect(findLeaks(haystack, text, { minGram: 9 }).length).toBe(0); // 原文只有 8 字
  });

  it('formatJsonLine 的输出形状固定（便于 grep 与人眼扫读）', () => {
    const line = formatJsonLine({
      ts: '2026-09-05T01:00:00.000Z',
      level: 'info',
      event: 'store.migration.done',
      service: 'store',
      fields: { schemaVersion: 3 },
    });
    expect(line).toBe(
      '{"ts":"2026-09-05T01:00:00.000Z","level":"info","event":"store.migration.done","service":"store","schemaVersion":3}',
    );
  });
});
