import { EXPERIMENTAL_METHOD, JsonRpcCallError, ERROR_CODE } from '@evowork/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  assertDegradationCoverage,
  CapabilityRegistry,
  DEGRADATION,
  FIELD_DEGRADATION,
  PROBE_ON_STARTUP,
  type CapabilityReport,
} from '../src/capabilities.js';

describe('降级表覆盖面（09 §3.3）', () => {
  it('**每个实验方法都有降级路径** —— 缺一条就是给未来留一次白屏', () => {
    expect(() => assertDegradationCoverage()).not.toThrow();
    for (const method of Object.values(EXPERIMENTAL_METHOD)) {
      expect(DEGRADATION[method], `${method} 缺降级`).toBeDefined();
      expect(DEGRADATION[method]?.userVisible, `${method} 缺用户可见文案`).toBeTruthy();
    }
  });

  it('collaborationMode 的降级带 mustAlsoDo：Ask 模式必须靠 ToolContributor 兜住（D8）', () => {
    const d = FIELD_DEGRADATION['turn/start.collaborationMode'];
    expect(d.mustAlsoDo).toContain('ToolContributor');
  });

  it('探测清单只含无副作用、无需上下文的方法', () => {
    // 需要 threadId 的方法拿假 id 探测会得到"找不到 thread"而不是"方法不存在"，判断反而更不准
    for (const method of PROBE_ON_STARTUP) {
      expect(method.startsWith('project/')).toBe(true);
    }
  });
});

describe('CapabilityRegistry —— 失败分类（这是降级与 bug 的分水岭）', () => {
  it('-32601（方法不存在）→ 降级', () => {
    const reports: CapabilityReport[] = [];
    const registry = new CapabilityRegistry((r) => reports.push(r));
    const err = new JsonRpcCallError('project/list', ERROR_CODE.methodNotFound, 'unknown method');

    const result = registry.classifyFailure('project/list', err);

    expect(result.degraded).toBe(true);
    expect(registry.isUsable('project/list')).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.degradation?.userVisible).toContain('项目');
  });

  it('**experimentalApi 门禁不算降级** —— 那是我们忘了声明 capability，必须响亮地失败', () => {
    const registry = new CapabilityRegistry();
    const err = new JsonRpcCallError(
      'thread/search',
      ERROR_CODE.invalidRequest,
      'thread/search requires experimentalApi capability',
    );

    const result = registry.classifyFailure('thread/search', err);

    expect(result.degraded).toBe(false);
    // 没被标记为不可用：把它当降级会让"实验方法全部不可用"静默变成常态
    expect(registry.isUsable('thread/search')).toBe(true);
    expect(err.isExperimentalGating).toBe(true);
  });

  it('普通业务错误不影响能力判定', () => {
    const registry = new CapabilityRegistry();
    const err = new JsonRpcCallError('thread/queue/add', ERROR_CODE.invalidParams, 'bad input');
    expect(registry.classifyFailure('thread/queue/add', err).degraded).toBe(false);
    expect(registry.isUsable('thread/queue/add')).toBe(true);
  });

  it('探测成功 → available；探测失败但不是 -32601 → 保持 unknown（不误杀）', async () => {
    const registry = new CapabilityRegistry();
    const reports = await registry.probeStartup(async () => {
      throw new Error('内核刚起来还没就绪');
    });
    // 关键：**不是** unavailable。误判会永久关掉一个其实可用的能力
    expect(reports[0]?.state).toBe('unknown');
    expect(registry.isUsable(EXPERIMENTAL_METHOD.projectList)).toBe(true);

    const ok = new CapabilityRegistry();
    const okReports = await ok.probeStartup(async () => undefined);
    expect(okReports[0]?.state).toBe('available');
  });

  it('探测遇到 -32601 → 立即降级', async () => {
    const registry = new CapabilityRegistry();
    const reports = await registry.probeStartup(async (method) => {
      throw new JsonRpcCallError(method, ERROR_CODE.methodNotFound, 'gone');
    });
    expect(reports[0]?.state).toBe('unavailable');
    expect(registry.unavailable()).toHaveLength(1);
  });

  it('unavailable() 汇总供设置页列出「当前不可用的能力」（降级一律显式）', () => {
    const registry = new CapabilityRegistry();
    registry.markUnavailable(EXPERIMENTAL_METHOD.threadRealtimeStart, 'METHOD_NOT_FOUND');
    registry.markUnavailable(EXPERIMENTAL_METHOD.threadSearch, 'METHOD_NOT_FOUND');
    const list = registry.unavailable();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.degradation?.userVisible)).toEqual(
      expect.arrayContaining(['语音输入不可用。', '内容搜索暂不可用，只能按任务标题搜。']),
    );
  });

  it('降级回调只在状态**变成**不可用时触发一次侧的语义清楚', () => {
    const onDegrade = vi.fn();
    const registry = new CapabilityRegistry(onDegrade);
    registry.markUnavailable(EXPERIMENTAL_METHOD.memoryReset, 'METHOD_NOT_FOUND');
    registry.markUnavailable(EXPERIMENTAL_METHOD.memoryReset, 'METHOD_NOT_FOUND');
    // 两次调用两次回调：去重是 UI 的事（它有 toast 节流），这一层保持无状态更好理解
    expect(onDegrade).toHaveBeenCalledTimes(2);
    registry.markAvailable(EXPERIMENTAL_METHOD.memoryReset);
    expect(registry.isUsable(EXPERIMENTAL_METHOD.memoryReset)).toBe(true);
  });
});
