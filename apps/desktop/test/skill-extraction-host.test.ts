// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createProjectRepo, openStore, type Store } from '@evowork/store';
import type { Adapter } from '@evowork/kernel-adapter';
import type { ThreadItem, Turn } from '@evowork/protocol';
import { makeThread, makeTurn } from '../../../services/kernel-adapter/test/fake-app-server.js';
import { createTaskEnvironments } from '../src/main/task-environments.js';
import { createFsCatalogPorts } from '../src/main/catalog-host.js';
import {
  createSkillExtractionHost,
  validateSkillDraft,
  type SkillExtractionHost,
} from '../src/main/skill-extraction-host.js';
import type { PublishedSkillDraft } from '../src/shared/skill-extraction.js';

let dir: string, data: string, project: string, kernelHome: string;
let store: Store, host: SkillExtractionHost, adapter: Adapter;
let bound: boolean, callId: string, failList: boolean;
let tasks: Map<string, { items: ThreadItem[]; turns: Turn[] }>;
let makeHost: () => SkillExtractionHost;
let createOptions: Parameters<Adapter['createTask']>[0] | undefined;
const enabled = new Map<string, boolean>();
const base: PublishedSkillDraft = {
  slug: 'sales-review',
  name: '销售复盘',
  description: '按确认口径分析区域销售异常。',
  instructions:
    '## 适用场景\n销售分析。\n## 每次需要的信息\n数据与月份。\n## 处理方法\n退款按实际发生月份冲减。\n## 交付要求\n结论引用数据。',
  changes: ['保留统计口径，月份参数化。'],
  sources: [{ rule: '退款口径', evidenceId: 'source-0' }],
  files: [],
};
function item(id: string, turnId: string, type: string, text: string): ThreadItem {
  return {
    id,
    _turnId: turnId,
    type,
    ...(type === 'userMessage' ? { content: [{ type: 'text', text }] } : { text }),
  } as unknown as ThreadItem;
}
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ew-skill-draft-')));
  data = join(dir, '.evowork');
  project = join(dir, 'project');
  kernelHome = join(data, 'kernel');
  await mkdir(join(data, 'kernel'), { recursive: true });
  await mkdir(join(data, 'plugins', 'skills'), { recursive: true });
  await mkdir(project);
  store = openStore({ path: join(data, 'test.db') });
  createProjectRepo(store.db).insert({
    id: 'project',
    name: '经营分析',
    roots: [project],
    createdAt: 1,
    updatedAt: 1,
  });
  store.threads.upsertFromThread(makeThread({ id: 'source', name: '销售分析', cwd: project }));
  const envs = createTaskEnvironments({
    store,
    home: dir,
    dataDir: data,
    projectRoot: (id) => (id === 'project' ? project : undefined),
  });
  envs.bind('source', await envs.prepare('source', 'project'));
  tasks = new Map([
    [
      'source',
      {
        turns: [
          makeTurn({ id: 'one', status: 'completed' }),
          makeTurn({ id: 'two', status: 'completed' }),
          makeTurn({ id: 'active', status: 'inProgress' }),
        ],
        items: [
          item('u1', 'one', 'userMessage', '退款按实际发生月份冲减。'),
          item('a1', 'one', 'agentMessage', '已确认口径。'),
          item('u2', 'two', 'userMessage', '报告附上数据证据。'),
          item('u3', 'active', 'userMessage', '尚未结束的回合不纳入。'),
        ],
      },
    ],
  ]);
  bound = true;
  callId = 'call-1';
  failList = false;
  enabled.clear();
  createOptions = undefined;
  let counter = 0;
  adapter = {
    openTask: vi.fn(async (id: string) => {
      const history = tasks.get(id);
      if (!history) throw new Error('历史缺失。');
      return {
        cached: [],
        items: Promise.resolve(history.items),
        turns: Promise.resolve(history.turns),
        latestTurn: Promise.resolve(history.turns.at(-1)),
      };
    }),
    resolveLocalToolCall: vi.fn(() =>
      bound ? { callId, turnId: 'edit-turn', generation: 1 } : undefined,
    ),
    createTask: vi.fn(async (args: Parameters<Adapter['createTask']>[0]) => {
      createOptions = args;
      const threadId = 'extract-' + ++counter;
      store.threads.upsertFromThread(
        makeThread({ id: threadId, cwd: args.overrides?.cwd ?? project }),
      );
      tasks.set(threadId, { items: [], turns: [makeTurn({ id: 'initial', status: 'completed' })] });
      args.onCreated?.(threadId);
      return { threadId, turn: makeTurn({ id: 'initial', status: 'completed' }), degradations: [] };
    }),
    setTaskName: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({})),
    listSkills: vi.fn(async (cwds: string[] = []) => {
      if (failList) throw new Error('目录暂不可用。');
      const root = cwds[0] ? join(cwds[0], '.agents', 'skills') : join(data, 'kernel', 'skills');
      const skills = existsSync(root)
        ? readdirSync(root)
            .filter((name) => existsSync(join(root, name, 'SKILL.md')))
            .map((name) => ({
              name,
              path: join(root, name, 'SKILL.md'),
              enabled: enabled.get(join(root, name, 'SKILL.md')) ?? true,
            }))
        : [];
      return { data: [{ cwd: cwds[0] ?? data, skills, errors: [] }] };
    }),
    setSkillEnabled: vi.fn(async (input: { path: string; enabled: boolean }) => {
      enabled.set(input.path, input.enabled);
      return input.enabled;
    }),
  } as unknown as Adapter;
  makeHost = () =>
    createSkillExtractionHost({
      store,
      adapter: () => adapter,
      environments: envs,
      catalog: createFsCatalogPorts({
        pluginsDir: join(data, 'plugins'),
        userRoot: data,
        kernelHome,
      }),
      dataDir: data,
      budget: () => 12000,
      denied: () => undefined,
      changed: vi.fn(),
    });
  host = makeHost();
  await host.ready;
});
afterEach(async () => {
  host.close();
  store.close();
  await rm(dir, { recursive: true, force: true });
});
async function start(content = base) {
  const draft = await host.startSkillExtraction({ threadId: 'source', modelId: 'test-model' });
  await host.call(draft.threadId, 'publish_skill_draft', { expectedRevision: 0, draft: content });
  return (await host.getSkillExtraction({ threadId: draft.threadId }))!;
}

describe('任务会话提炼技能的实际存储与安装后果', () => {
  it('创建关联任务前固定来源范围，排除在途回合；草稿不进入技能目录且并发发起不重复', async () => {
    const [first, second] = await Promise.all([
      host.startSkillExtraction({
        threadId: 'source',
        fromTurnId: 'two',
        focus: '只保留报告结构',
        modelId: 'test-model',
      }),
      host.startSkillExtraction({ threadId: 'source' }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.source.evidence.map((x) => x.text)).toEqual(['报告附上数据证据。']);
    expect(first.source.turns).toHaveLength(1);
    expect(createOptions?.overrides).toMatchObject({
      model: 'test-model',
      budgetLimit: 12000,
      cwd: project,
      modeId: 'request-approval',
    });
    expect(existsSync(join(project, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(data, 'skills'))).toBe(false);
  });
  it('草稿发布校验真实调用、修订与来源，重新创建宿主仍能恢复内容', async () => {
    const draft = await start();
    bound = false;
    await expect(host.call(draft.threadId, 'get_skill_draft', {})).rejects.toThrow('来源任务');
    bound = true;
    callId = 'new-call';
    await expect(
      host.call(draft.threadId, 'publish_skill_draft', { expectedRevision: 0, draft: base }),
    ).rejects.toThrow('修订');
    await expect(
      host.call(draft.threadId, 'publish_skill_draft', {
        expectedRevision: 1,
        draft: { ...base, sources: [{ rule: '捏造', evidenceId: 'other-task' }] },
      }),
    ).rejects.toThrow('来源标识');
    expect((await host.getSkillExtraction({ threadId: 'source' }))?.content).toEqual(base);
    expect(
      store.db
        .prepare("SELECT value FROM meta WHERE key LIKE 'evowork.skillExtraction.draft.%'")
        .all(),
    ).toHaveLength(1);
    host.close();
    store.close();
    store = openStore({ path: join(data, 'test.db') });
    host = makeHost();
    await host.ready;
    expect((await host.getSkillExtraction({ threadId: draft.threadId }))?.content).toEqual(base);
  });
  it('项目技能只写项目目录，资源同时落盘；新修订需要重新保存，旧修订不能覆盖', async () => {
    const content = {
      ...base,
      instructions: base.instructions + '\n参见[口径](references/schema.md)。',
      files: [{ path: 'references/schema.md', content: '口径说明' }],
    };
    const draft = await start(content);
    const saved = await host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 });
    expect(saved.draft.state).toBe('saved');
    expect(
      await readFile(join(project, '.agents/skills/sales-review/references/schema.md'), 'utf8'),
    ).toBe('口径说明');
    expect(existsSync(join(data, 'skills/sales-review'))).toBe(false);
    expect(existsSync(join(data, 'kernel/skills/sales-review'))).toBe(false);
    callId = 'edit-2';
    await host.call(draft.threadId, 'publish_skill_draft', {
      expectedRevision: 1,
      draft: {
        ...content,
        instructions: '## 交付要求\n只输出异常清单。',
        changes: ['移除报告生成。'],
      },
    });
    await expect(
      host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 }),
    ).rejects.toThrow('最新版本');
    expect(await readFile(join(project, '.agents/skills/sales-review/SKILL.md'), 'utf8')).toContain(
      '退款按实际发生',
    );
    expect(
      (await host.saveSkillExtraction({ threadId: draft.threadId, revision: 2 })).draft.state,
    ).toBe('saved');
    expect(await readFile(join(project, '.agents/skills/sales-review/SKILL.md'), 'utf8')).toContain(
      '只输出异常清单',
    );
  });
  it('全局安装保留两份副本，目录核对失败如实记录，重试后才报告启用', async () => {
    const draft = await start();
    await host.setSkillExtractionScope({ threadId: draft.threadId, revision: 1, scope: 'global' });
    failList = true;
    const result = await host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 });
    expect(result.draft.state).toBe('enable-failed');
    expect(existsSync(join(data, 'skills/sales-review/SKILL.md'))).toBe(true);
    expect(await readFile(join(data, 'kernel/skills/sales-review/SKILL.md'), 'utf8')).toContain(
      '销售复盘',
    );
    failList = false;
    expect(
      (await host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 })).draft.state,
    ).toBe('saved');
  });
  it('同名技能不覆盖，危险能力必须先确认且被审计脚本不执行', async () => {
    const draft = await start({
      ...base,
      instructions: base.instructions + '\n执行 scripts/run.sh。',
      files: [
        { path: 'scripts/run.sh', content: '#!/bin/sh\ntouch /tmp/DO_NOT_EXECUTE_SKILL_DRAFT\n' },
      ],
    });
    const first = await host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 });
    expect(first.needsConfirm).toBe(true);
    expect(existsSync(join(project, '.agents/skills/sales-review'))).toBe(false);
    await mkdir(join(project, '.agents/skills/sales-review'), { recursive: true });
    await writeFile(join(project, '.agents/skills/sales-review/SKILL.md'), '用户原文件');
    await expect(
      host.saveSkillExtraction({
        threadId: draft.threadId,
        revision: 1,
        acknowledge: true,
        confirmName: 'sales-review',
      }),
    ).rejects.toThrow('同名技能');
    expect(await readFile(join(project, '.agents/skills/sales-review/SKILL.md'), 'utf8')).toBe(
      '用户原文件',
    );
  });
  it('拒绝软链写出项目、资源路径穿越和引用缺失，错误不回显正文', async () => {
    const draft = await start();
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(project, '.agents'));
    await expect(
      host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 }),
    ).rejects.toThrow('目标技能目录');
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const path of ['../secret', 'assets/../../secret', 'scripts//bad', '/tmp/a'])
      expect(() =>
        validateSkillDraft(
          { ...base, files: [{ path, content: 'PRIVATE_SENTINEL' }] },
          draft.source.evidence,
        ),
      ).toThrow('安全');
    expect(() =>
      validateSkillDraft(
        { ...base, instructions: '[缺失](assets/nope.txt)' },
        draft.source.evidence,
      ),
    ).toThrow('未包含');
  });
  it('补充最新记录不会重新纳入用户排除的早期回合', async () => {
    const draft = await host.startSkillExtraction({ threadId: 'source', fromTurnId: 'two' });
    tasks.get('source')!.turns[2] = makeTurn({ id: 'active', status: 'completed' });
    const next = await host.refreshSkillSource({ threadId: draft.threadId });
    expect(next.source.turns.map((turn) => turn.id)).toEqual(['two', 'active']);
    expect(next.source.evidence.some((item) => item.itemId === 'u1')).toBe(false);
    expect(next.source.evidence.some((item) => item.itemId === 'u3')).toBe(true);
  });
  it('删除来源清除原文证据，删除提炼任务清理草稿，已安装文件保留', async () => {
    const draft = await start();
    await host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 });
    host.removed('source');
    expect(
      (await host.getSkillExtraction({ threadId: draft.threadId }))?.source.evidence.every(
        (item) => !item.text,
      ),
    ).toBe(true);
    host.removed(draft.threadId);
    expect(await host.getSkillExtraction({ threadId: draft.threadId })).toBeNull();
    expect(existsSync(join(project, '.agents/skills/sales-review/SKILL.md'))).toBe(true);
  });
  it('全局镜像使用路径别名时按真实目录匹配，不误报未发现', async () => {
    const alias = join(dir, 'kernel-alias');
    await symlink(join(data, 'kernel'), alias);
    host.close();
    kernelHome = alias;
    host = makeHost();
    await host.ready;
    const draft = await start();
    await host.setSkillExtractionScope({ threadId: draft.threadId, revision: 1, scope: 'global' });
    expect(
      (await host.saveSkillExtraction({ threadId: draft.threadId, revision: 1 })).draft.state,
    ).toBe('saved');
  });
  it('令牌与真实在途来源必须同时满足，令牌轮换后旧请求被拒绝', async () => {
    const draft = await start();
    const env = host.environment;
    const body = JSON.stringify({
      threadId: draft.threadId,
      name: 'get_skill_draft',
      arguments: {},
    });
    expect((await fetch(env.EVOWORK_SKILL_DRAFT_ENDPOINT, { method: 'POST', body })).status).toBe(
      403,
    );
    const invoke = () =>
      fetch(env.EVOWORK_SKILL_DRAFT_ENDPOINT, {
        method: 'POST',
        body,
        headers: { Authorization: 'Bearer ' + env.EVOWORK_SKILL_DRAFT_TOKEN },
      });
    expect((await invoke()).status).toBe(200);
    bound = false;
    expect((await invoke()).status).toBe(400);
    bound = true;
    host.rotate();
    expect((await invoke()).status).toBe(403);
  });
});
