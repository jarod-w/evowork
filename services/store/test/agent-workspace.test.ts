import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentWorkspaceStore,
  openStore,
  writeMeta,
  migrateProjection,
  dropProjectionTables,
  type AgentWorkspaceItem,
} from '../src/index.js';

const single: AgentWorkspaceItem = {
  id: 'a',
  kind: 'single',
  name: '审阅员',
  description: '核对资料',
  instructions: '引用依据',
  skills: [],
  connectors: ['files'],
  icon: 'agent',
  example: false,
};

describe('智能体权威配置', () => {
  it('从 v7 升级前备份，保留旧数据并创建智能体权威表', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-upgrade-'));
    const path = join(root, 'test.db');
    let store = openStore({ path });
    try {
      store.db.exec('DROP TABLE agent_workspace; DROP TABLE agent_workspace_run');
      writeMeta(store.db, 'schema_version_authoritative', '7');
      writeMeta(store.db, 'existing-data', 'preserved');
      store.close();
      store = openStore({ path });
      expect(existsSync(`${path}.bak.7`)).toBe(true);
      expect(store.db.prepare("SELECT value FROM meta WHERE key='existing-data'").get()).toEqual({
        value: 'preserved',
      });
      const repo = new AgentWorkspaceStore(store);
      expect(repo.save(single).name).toBe(single.name);
      expect(repo.runs()).toEqual([]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('重新打开数据库及重建投影都保留配置，更新与删除拒绝过期版本', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workspace-'));
    const path = join(root, 'test.db');
    let store = openStore({ path });
    try {
      let repo = new AgentWorkspaceStore(store);
      const saved = repo.save(single);
      expect(saved.revision).toBe(1);
      store.close();
      store = openStore({ path });
      repo = new AgentWorkspaceStore(store);
      dropProjectionTables(store.db);
      migrateProjection(store.db);
      expect(repo.get('a')).toEqual(saved);
      const changed = repo.save({ ...saved, name: '复核员' });
      expect(() => repo.save({ ...saved, name: '过期编辑' })).toThrow('配置已改变');
      expect(() => repo.remove('a', saved.revision!)).toThrow('配置已改变');
      expect(repo.get('a').name).toBe('复核员');
      repo.remove('a', changed.revision!);
      expect(repo.list()).toEqual([]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('拒绝不可信配置；删除单体不修改团队成员快照', () => {
    const store = openStore({ path: ':memory:' });
    try {
      const repo = new AgentWorkspaceStore(store);
      expect(() => repo.save({ ...single, connectors: ['feishu'] })).toThrow('尚未接入');
      expect(() => repo.save({ kind: 'single' })).toThrow();
      const saved = repo.save(single);
      const team = repo.save({
        ...single,
        id: 'team',
        kind: 'team',
        architecture: 'custom',
        members: [
          { ...single, lead: true },
          { ...single, id: 'b', lead: false },
        ],
        nodes: [
          { id: 'n', name: '处理', memberId: 'b', input: '', output: '', condition: 'human' },
        ],
      });
      expect(() =>
        repo.save({
          ...team,
          nodes: [{ id: 'n', name: '悬空', memberId: 'missing', condition: 'success' }],
        }),
      ).toThrow();
      repo.remove(saved.id, saved.revision!);
      expect(repo.get(team.id)).toEqual(team);
    } finally {
      store.close();
    }
  });
});
