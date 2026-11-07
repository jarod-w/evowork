import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkspaceStore, openStore, type Store, type TeamAgentDraft } from '@evowork/store';
import type { Adapter } from '../src/adapter.js';
import { AgentWorkspaceRunner } from '../src/agent-workspace.js';

const role = {
  id: 'lead',
  name: '主控',
  description: '核对',
  instructions: '按事实回答',
  skills: [],
  connectors: ['files'],
};
const team: TeamAgentDraft = {
  ...role,
  id: 'team',
  kind: 'team',
  example: false,
  icon: 'team',
  architecture: 'parallel',
  members: [
    { ...role, lead: true },
    { ...role, id: 'worker', lead: false },
  ],
  nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
    id,
    name: id,
    memberId: 'worker',
    input: '',
    output: '',
    condition: 'success',
  })),
};
let store: Store;
let runner: AgentWorkspaceRunner;
afterEach(() => {
  runner?.close();
  store?.close();
});
function setup(value = team) {
  store = openStore({ path: ':memory:' });
  const repo = new AgentWorkspaceStore(store);
  repo.save(value);
  let seq = 0;
  const pending = new Map<string, (value: Awaited<ReturnType<Adapter['createTask']>>) => void>();
  const port = {
    createTask: vi.fn((args: Parameters<Adapter['createTask']>[0]) => {
      const id = String(++seq);
      args.onCreated?.(id);
      return new Promise<Awaited<ReturnType<Adapter['createTask']>>>((resolve) =>
        pending.set(id, resolve),
      );
    }),
    interrupt: vi.fn(async () => {}),
    terminateTaskCommands: vi.fn(async () => {}),
    communicationHistory: vi.fn(
      async (id: string) =>
        [
          {
            id: `turn-${id}`,
            status: 'completed',
            error: null,
            items: [{ id: `answer-${id}`, type: 'agentMessage', text: `真实输出-${id}` }],
          },
        ] as Awaited<ReturnType<Adapter['communicationHistory']>>,
    ),
  };
  runner = new AgentWorkspaceRunner(store, port);
  const finish = (id: string) => {
    store.db
      .prepare(
        "INSERT INTO thread_projection(thread_id,cwd,derived_status) VALUES(?,?,'completed')",
      )
      .run(id, '/tmp/test');
    pending.get(id)!({
      threadId: id,
      turn: { id: `turn-${id}`, status: 'completed', error: null, items: [] },
      degradations: [],
    });
  };
  return { repo, port, finish };
}
describe('团队真实节点编排', () => {
  it('首节点完成后才并行，最大三路，输出传递到末节点', async () => {
    const { port, finish } = setup();
    runner.start({ agentId: 'team', prompt: '执行', cwd: '/tmp/test' });
    expect(port.createTask).toHaveBeenCalledTimes(1);
    finish('1');
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledTimes(4));
    expect(port.createTask.mock.calls[1]![0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('真实输出-1') }),
      ]),
    );
    finish('2');
    finish('3');
    finish('4');
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledTimes(5));
    finish('5');
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledTimes(6));
    finish('6');
    await vi.waitFor(() => expect(runner.get('team')?.status).toBe('completed'));
  });
  it('有真实输出后才等待确认，停止等待节点不启动后续任务', async () => {
    const value = structuredClone(team);
    value.architecture = 'custom';
    value.nodes[0]!.condition = 'human';
    const { port, finish, repo } = setup(value);
    const run = runner.start({ agentId: 'team', prompt: '执行', cwd: '/tmp/test' });
    await expect(runner.decide({ runId: run.id, nodeId: 'a', action: 'confirm' })).rejects.toThrow(
      '没有等待',
    );
    finish('1');
    await vi.waitFor(() => expect(runner.get('team')?.status).toBe('waiting'));
    expect(runner.get('team')!.nodes[0]!.output).toBe('真实输出-1');
    expect(() => repo.remove('team', 1)).toThrow('先停止运行');
    expect(port.createTask.mock.calls[0]![0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('团队职责：核对') }),
      ]),
    );
    await runner.decide({ runId: run.id, action: 'stop' });
    expect(port.createTask).toHaveBeenCalledTimes(1);
    expect(runner.get('team')!.status).toBe('stopped');
    repo.remove('team', 1);
    expect(repo.list()).toEqual([]);
  });
  it('停止时仍在创建的任务返回后也必须中断，不能推进下一节点', async () => {
    const { port, finish } = setup();
    const run = runner.start({ agentId: 'team', prompt: '执行', cwd: '/tmp/test' });
    await runner.decide({ runId: run.id, action: 'stop' });
    finish('1');
    await vi.waitFor(() => expect(port.terminateTaskCommands).toHaveBeenCalledWith('1'));
    expect(port.createTask).toHaveBeenCalledTimes(1);
    expect(runner.get('team')!.status).toBe('stopped');
  });
  it('节点失败阻止后续批次，重启不自动重新投递', async () => {
    const { port, finish } = setup();
    port.communicationHistory.mockRejectedValueOnce(new Error('读取失败'));
    runner.start({ agentId: 'team', prompt: '执行', cwd: '/tmp/test' });
    finish('1');
    await vi.waitFor(() => expect(runner.get('team')?.status).toBe('failed'));
    expect(port.createTask).toHaveBeenCalledTimes(1);
    runner.close();
    runner = new AgentWorkspaceRunner(store, port);
    expect(runner.get('team')?.status).toBe('failed');
    expect(port.createTask).toHaveBeenCalledTimes(1);
  });
  it('并行节点失败立即停止，但等在途创建收尾后才允许新运行', async () => {
    const { port, finish } = setup();
    runner.start({ agentId: 'team', prompt: '执行', cwd: '/tmp/test' });
    finish('1');
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledTimes(4));
    port.communicationHistory.mockRejectedValueOnce(new Error('模型失败'));
    finish('2');
    await vi.waitFor(() => expect(runner.get('team')?.status).toBe('failed'));
    expect(() => runner.start({ agentId: 'team', prompt: '重试', cwd: '/tmp/test' })).toThrow(
      '已有团队',
    );
    finish('3');
    finish('4');
    await vi.waitFor(() => expect(port.interrupt).toHaveBeenCalledWith('4'));
    expect(port.createTask).toHaveBeenCalledTimes(4);
  });
  it('遵守调低的并发与任务预算；重启中断旧运行且不重投', async () => {
    const { port, finish, repo } = setup();
    const run = runner.start({
      agentId: 'team',
      prompt: '执行',
      cwd: '/tmp/test',
      concurrencyLimit: 1,
      budgetLimit: 9000,
    });
    expect(port.createTask.mock.calls[0]![0].overrides?.budgetLimit).toBe(9000);
    finish('1');
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledTimes(2));
    expect(port.createTask).toHaveBeenCalledTimes(2);
    runner.close();
    // 模拟进程在权威运行状态仍为 running 时终止。
    repo.saveRun({ ...repo.run(run.id), status: 'running' });
    runner = new AgentWorkspaceRunner(store, port);
    await runner.recover();
    expect(runner.get('team')?.status).toBe('interrupted');
    expect(port.createTask).toHaveBeenCalledTimes(2);
    expect(port.interrupt).toHaveBeenCalledWith('2');
  });
  it('后台命令终止未确认时显示失败，不把节点标成已安全停止', async () => {
    const { port } = setup();
    const run = runner.start({ agentId: 'team', prompt: '执行', cwd: '/tmp/test' });
    port.terminateTaskCommands.mockRejectedValueOnce(new Error('后台接口不可用'));
    const stopped = await runner.decide({ runId: run.id, action: 'stop' });
    expect(stopped.status).toBe('failed');
    expect(stopped.logs.join('\n')).toContain('后台命令未确认停止');
    expect(port.terminateTaskCommands).toHaveBeenCalledWith('1');
  });
});
