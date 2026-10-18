import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FollowUpStore, openStore, dropProjectionTables, migrateProjection } from '../src/index.js';

describe('重启后的权威回执与本机队列', () => {
  it('关闭数据库后回执、顺序、引用、暂停和派发身份仍在，投影重建不清除', () => {
    const home = mkdtempSync(join(tmpdir(), 'evowork-outbox-'));
    const path = join(home, 'state.db');
    let store = openStore({ path });
    try {
      let state = new FollowUpStore(store);
      state.saveReceipt('send-1', 'task', {
        fingerprint: 'hash-only',
        route: 'queue',
        result: { queued: true, degradations: [] },
      });
      state.set('task', [
        {
          id: 'b',
          input: [
            { type: 'text', text: '第二条已编辑' },
            { type: 'mention', path: '/local/a.txt', name: 'a.txt' },
          ],
          dispatchId: 'dispatch-b',
        },
        {
          id: 'a',
          input: [{ type: 'text', text: '第一条' }],
          nativeId: 'native-a',
          clientId: 'send-1',
        },
      ]);
      state.savePending('send-1', 'draft-1', 'task', {
        submissionId: 'send-1',
        text: '待确认草稿',
      });
      state.pause('task');
      store.close();
      store = openStore({ path });
      dropProjectionTables(store.db);
      migrateProjection(store.db);
      state = new FollowUpStore(store);
      expect(state.receipt('send-1')).toMatchObject({
        fingerprint: 'hash-only',
        result: { queued: true },
      });
      expect(state.get('task')).toMatchObject([
        {
          id: 'b',
          dispatchId: 'dispatch-b',
          input: [{ text: '第二条已编辑' }, { path: '/local/a.txt' }],
        },
        { id: 'a', nativeId: 'native-a', clientId: 'send-1' },
      ]);
      expect(state.has('task')).toBe(true);
      expect(state.pending()).toEqual({ submissionId: 'send-1', text: '待确认草稿' });
      expect(JSON.stringify(state.receipt('send-1'))).not.toContain('第二条已编辑');
      state.delete('task');
      expect(state.get('task')).toBeUndefined();
      expect(state.receipt('send-1')).toBeUndefined();
      expect(state.pending()).toBeUndefined();
      expect(state.has('task')).toBe(false);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('退出前未暂停的本机队列恢复后也等待明确继续', () => {
    const store = openStore({ path: ':memory:' });
    try {
      const before = new FollowUpStore(store);
      before.set('task', [{ id: 'q', input: [{ type: 'text', text: '未运行的输入' }] }]);
      before.resume('task');
      const after = new FollowUpStore(store);
      expect(after.has('task')).toBe(true);
      expect(after.get('task')).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it('旧权威 v5 库升级新增持久回执表，已有数据仍在', () => {
    const home = mkdtempSync(join(tmpdir(), 'evowork-outbox-upgrade-'));
    const path = join(home, 'state.db');
    let store = openStore({ path });
    try {
      store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('upgrade-sentinel', 'keep');
      for (const name of [
        'follow_up_receipt',
        'follow_up_queue',
        'follow_up_control',
        'follow_up_composer',
      ])
        store.db.exec(`DROP TABLE ${name}`);
      store.db
        .prepare('UPDATE meta SET value = ? WHERE key = ?')
        .run('5', 'schema_version_authoritative');
      store.close();
      store = openStore({ path });
      const state = new FollowUpStore(store);
      state.saveReceipt('one', 'task', { fingerprint: 'safe' });
      expect(state.receipt('one')).toEqual({ fingerprint: 'safe' });
      expect(
        store.db.prepare('SELECT value FROM meta WHERE key = ?').get('upgrade-sentinel'),
      ).toEqual({ value: 'keep' });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
