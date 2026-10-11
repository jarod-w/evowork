import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, ThreadMessages, type Store } from '@evowork/store';
import type { Turn } from '@evowork/protocol';
import {
  createThreadCommunication,
  type ThreadCommunication,
  type CommunicationPort,
} from '../src/thread-communication.js';
import { makeThread, makeTurn } from './fake-app-server.js';

let store: Store;
let bridge: ThreadCommunication;
let history: Map<string, Turn[]>;
let deliver: ReturnType<typeof vi.fn<CommunicationPort['deliver']>>;
function seed(id: string, project: string | null = 'p') {
  store.threads.upsertFromThread(makeThread({ id, name: id, cwd: '/workspace/' + id }));
  store.db.prepare('UPDATE thread_projection SET project_id=? WHERE thread_id=?').run(project, id);
}
function create() {
  return createThreadCommunication({
    store,
    projectOf: (threadId) => store.threads.get(threadId)?.project_id ?? null,
    port: { ready: () => true, history: async (id) => history.get(id) ?? [], deliver },
  });
}
const request = (text = '核对季度数据', clientId = 'once') => ({
  sourceThreadId: 'a',
  targetThreadId: 'b',
  text,
  clientId,
});
beforeEach(() => {
  store = openStore({ path: ':memory:' });
  seed('a');
  seed('b');
  seed('other', 'q');
  seed('loose', null);
  history = new Map();
  deliver = vi.fn(async (threadId: string, text: string) => {
    const turn = makeTurn({
      id: `turn-${deliver.mock.calls.length}`,
      items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text }] }],
      status: 'inProgress',
    });
    history.set(threadId, [...(history.get(threadId) ?? []), turn]);
    store.db
      .prepare(
        "UPDATE thread_projection SET last_turn_status='inProgress',derived_status='running',last_turn_id=? WHERE thread_id=?",
      )
      .run(turn.id, threadId);
    return turn.id;
  });
  bridge = create();
});
afterEach(() => {
  bridge.stop();
  store.close();
});
async function complete(threadId: string, text: string, status: Turn['status'] = 'completed') {
  const turn = history.get(threadId)!.at(-1)!;
  const completed = {
    ...turn,
    status,
    items: [...turn.items, { type: 'agentMessage', id: 'result', text, phase: 'final_answer' }],
  };
  history.set(threadId, [...history.get(threadId)!.slice(0, -1), completed]);
  store.db
    .prepare(
      'UPDATE thread_projection SET last_turn_status=?,derived_status=?,last_turn_id=? WHERE thread_id=?',
    )
    .run(status, status, turn.id, threadId);
  bridge.onEvent({ type: 'turn-completed', threadId, turnId: turn.id, status });
}
describe('独立会话请求与回复', () => {
  it('同项目默认发现，跨项目需明确选择，无项目不互相发现', () => {
    expect(bridge.targets('a').map((t) => t.id)).toEqual(['b']);
    expect(bridge.targets('loose')).toEqual([]);
    expect(bridge.targets('a', true).map((t) => t.id)).toEqual(
      expect.arrayContaining(['other', 'loose']),
    );
    expect(bridge.send({ ...request(), targetThreadId: 'other' }).target_thread_id).toBe('other');
  });
  it('独立请求去重且同标识不能换目标或正文', () => {
    const first = bridge.send(request());
    expect(bridge.send(request()).id).toBe(first.id);
    expect(() => bridge.send(request('更换内容'))).toThrow('发送标识');
    expect(() => bridge.send({ ...request(), targetThreadId: 'other' })).toThrow('发送标识');
  });
  it('目标忙碌时持久排队，空闲后执行并把回复送回来源；汇总不自动再回信', async () => {
    store.db
      .prepare(
        "UPDATE thread_projection SET last_turn_status='inProgress',derived_status='running' WHERE thread_id='b'",
      )
      .run();
    const message = bridge.send(request());
    await bridge.start();
    expect(deliver).not.toHaveBeenCalled();
    store.db
      .prepare(
        "UPDATE thread_projection SET last_turn_status='completed',derived_status='completed' WHERE thread_id='b'",
      )
      .run();
    bridge.onEvent({ type: 'turn-completed', threadId: 'b', turnId: 'old', status: 'completed' });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0]![1]).toContain(message.id);
    await complete('b', '已核对，合计正确');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]![0]).toBe('a');
    expect(deliver.mock.calls[1]![1]).toContain('已核对，合计正确');
    await complete('a', '核对完成');
    await vi.waitFor(() => expect(bridge.list('a')[0]!.status).toBe('completed'));
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('来源忙碌时回复排队，不打断它当前的回合', async () => {
    bridge.send(request());
    await bridge.start();
    store.db
      .prepare(
        "UPDATE thread_projection SET last_turn_status='inProgress',derived_status='running' WHERE thread_id='a'",
      )
      .run();
    await complete('b', '结果');
    await vi.waitFor(() => expect(bridge.list('a')[0]!.status).toBe('reply-queued'));
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('失败与停止也回传明确结果', async () => {
    bridge.send(request());
    await bridge.start();
    await complete('b', '', 'interrupted');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]![1]).toContain('已停止');
  });
  it('归档不自动唤醒，投递前再次核对双方', async () => {
    bridge.send(request());
    store.db.prepare("UPDATE thread_projection SET archived=1 WHERE thread_id='b'").run();
    await bridge.start();
    expect(deliver).not.toHaveBeenCalled();
    expect(bridge.list('a')[0]!.status).toBe('failed');
    expect(() => bridge.send(request('新请求', 'two'))).toThrow('归档');
  });
  it('子代理与定时任务不参与，拒绝自身和超长请求', () => {
    store.db.prepare("UPDATE thread_projection SET parent_thread_id='a' WHERE thread_id='b'").run();
    expect(() => bridge.send(request())).toThrow('独立');
    expect(() => bridge.send({ ...request(), targetThreadId: 'a' })).toThrow('另一个');
    expect(() => bridge.send(request('x'.repeat(12001)))).toThrow('12000');
    store.db
      .prepare(
        "UPDATE thread_projection SET parent_thread_id=NULL,automation_id='timer' WHERE thread_id='b'",
      )
      .run();
    expect(bridge.targets('a')).toEqual([]);
  });
  it('删除任一任务清理全部相关正文，排队取消后不执行', async () => {
    const first = bridge.send(request());
    bridge.cancel('a', first.id);
    await bridge.start();
    expect(deliver).not.toHaveBeenCalled();
    bridge.onEvent({ type: 'task-removed', threadId: 'b' });
    expect(bridge.list('a')).toEqual([]);
  });
  it('重建服务继续持久队列并核对已投递回合，不重复执行', async () => {
    bridge.send(request());
    bridge.stop();
    bridge = create();
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(1);
    bridge.stop();
    bridge = create();
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(1);
    await complete('b', '结果');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
  });
  it('响应丢失但内核已接收时，重启按请求标识找回原回合', async () => {
    const actual = deliver.getMockImplementation()!;
    deliver.mockImplementation(async (tid, text) => {
      await actual(tid, text);
      throw new Error('transport lost');
    });
    bridge.send(request());
    await bridge.start();
    expect(bridge.list('a')[0]!.status).toBe('unknown');
    bridge.stop();
    bridge = create();
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(bridge.list('a')[0]!.status).toBe('waiting');
  });
  it('无法确认投递时不重放，人工核对也不重复发送', async () => {
    deliver.mockRejectedValue(new Error('lost'));
    const message = bridge.send(request());
    await bridge.start();
    await bridge.check('a', message.id);
    bridge.stop();
    bridge = create();
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(bridge.list('a')[0]!.status).toBe('unknown');
  });
  it('并发恢复只投递一次', async () => {
    bridge.send(request());
    await Promise.all([bridge.start(), bridge.start(), bridge.start()]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('回合在投递响应前完成也可回传，不依赖 turn-started 误认其他回合', async () => {
    deliver.mockImplementation(async (threadId, text) => {
      history.set(threadId, [
        makeTurn({
          id: threadId + '-done',
          status: 'completed',
          items: [
            { type: 'userMessage', id: 'u', content: [{ type: 'text', text }] },
            { type: 'agentMessage', id: 'f', phase: 'final_answer', text: '快速完成' },
          ],
        }),
      ]);
      return threadId + '-done';
    });
    bridge.send(request());
    await bridge.start();
    await vi.waitFor(() => expect(bridge.list('a')[0]!.status).toBe('completed'));
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('回复投递响应丢失，重启核对后不重放汇总回合', async () => {
    bridge.send(request());
    await bridge.start();
    const actual = deliver.getMockImplementation()!;
    deliver.mockImplementation(async (tid, text) => {
      const turn = await actual(tid, text);
      if (tid === 'a') throw new Error('lost reply');
      return turn;
    });
    await complete('b', '结果');
    await vi.waitFor(() => expect(bridge.list('a')[0]!.status).toBe('reply-unknown'));
    bridge.stop();
    bridge = create();
    await bridge.start();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(bridge.list('a')[0]!.status).toBe('reply-dispatching');
  });
  it('权威队列正文不依赖投影表，不受投影重建影响', () => {
    const message = bridge.send(request());
    store.threads.remove('b');
    expect(new ThreadMessages(store.db).get(message.id)?.text).toBe('核对季度数据');
  });
  it('目标失败时即使有局部答案，也明确回传未完成', async () => {
    bridge.send(request());
    await bridge.start();
    await complete('b', '只核对了第一张表', 'failed');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]![1]).toContain('执行失败');
    expect(deliver.mock.calls[1]![1]).toContain('只核对了第一张表');
  });
  it('停止后迟到的投递响应不改写状态，下一次恢复按历史核对', async () => {
    const actual = deliver.getMockImplementation()!;
    let release: (() => void) | undefined;
    deliver.mockImplementation(async (tid, text) => {
      const turnId = await actual(tid, text);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return turnId;
    });
    bridge.send(request());
    const starting = bridge.start();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    bridge.stop();
    release!();
    await starting;
    expect(bridge.list('a')[0]!.status).toBe('dispatching');
    bridge = create();
    await bridge.start();
    expect(bridge.list('a')[0]!.status).toBe('waiting');
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('最近记录超过一页不会漏掉早先未完成请求的回复', async () => {
    const message = bridge.send(request());
    await bridge.start();
    const repo = new ThreadMessages(store.db);
    for (let i = 0; i < 110; i += 1)
      repo.insert({
        ...message,
        id: 'recent-' + i,
        dedupe_key: 'recent-' + i,
        status: 'completed',
        created_at: message.created_at + i + 1,
      });
    expect(bridge.list('a')[0]!.id).toBe(message.id);
    await complete('b', '早先的回复');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]![1]).toContain('早先的回复');
  });
  it('长回复明确提示截断，并且未知结果核对成功后清除旧错误', async () => {
    const actual = deliver.getMockImplementation()!;
    deliver.mockImplementationOnce(async (tid, text) => {
      await actual(tid, text);
      throw new Error('lost');
    });
    const message = bridge.send(request());
    await bridge.start();
    expect(bridge.list('a')[0]!.status).toBe('unknown');
    await bridge.check('a', message.id);
    expect(bridge.list('a')[0]!.error).toBeNull();
    await complete('b', 'x'.repeat(13000));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]![1]).toContain('已截断');
  });
});
