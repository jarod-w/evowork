import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HubIndexPayload, HubItem } from '@evowork/hub-protocol';
import { describe, expect, it } from 'vitest';

import { AUDIT_RULES_VERSION, extractCapabilities } from '../src/audit.js';
import {
  capabilityGrowth,
  decideUpdate,
  hubEntries,
  parseHubInstallState,
  reconcileAudit,
  serializeHubInstallState,
  skillCatalogBudget,
  skillCatalogCost,
  upsertInstalled,
  type HubInstalled,
} from '../src/hub.js';

function item(over: Partial<HubItem> = {}): HubItem {
  return {
    id: 'minutes',
    kind: 'skill',
    version: '1.1.0',
    package: { path: 'pkgs/skill/minutes/1.1.0.tar.gz', sha256: 'a'.repeat(64), size: 1 },
    defaultEnabled: true,
    promptVisible: true,
    interface: { displayName: '会议纪要', description: '整理纪要', category: '办公' },
    audit: { level: 'p0', rulesVersion: 'r1', network: [], commands: [], hooks: false },
    license: { spdx: 'MIT' },
    ...over,
  };
}

function index(items: HubItem[], revoked: HubIndexPayload['revoked'] = []): HubIndexPayload {
  return {
    schemaVer: 1,
    source: { id: 'evowork', displayName: 'EvoWork 精选' },
    sequence: 1,
    issuedAt: 1,
    expiresAt: 2,
    items,
    revoked,
  };
}

const installed: HubInstalled = {
  sourceId: 'evowork',
  kind: 'skill',
  id: 'minutes',
  version: '1.0.0',
  level: 'p0',
  network: [],
  commands: [],
  hooks: false,
  promptVisible: true,
  installedAt: 1,
};

describe('更新判定（13 §5.4，HUB-Q4=A）', () => {
  it('能力没扩大 → 静默更新', () => {
    expect(decideUpdate(installed, index([item()]), '0.0.5').kind).toBe('silent');
  });

  it('等级没升、但多了一个域名 → 不自动更新，并说清多了什么', () => {
    const next = item({
      audit: {
        level: 'p0',
        rulesVersion: 'r1',
        network: ['api.x.com'],
        commands: [],
        hooks: false,
      },
    });
    const d = decideUpdate(installed, index([next]), '0.0.5');
    expect(d.kind).toBe('reconfirm');
    expect(d.kind === 'reconfirm' && d.why.join()).toMatch(/api\.x\.com/);
  });

  it('新增 hooks / 等级升高 → 需重新确认', () => {
    const hooks = item({
      audit: { level: 'p0', rulesVersion: 'r1', network: [], commands: [], hooks: true },
    });
    expect(decideUpdate(installed, index([hooks]), '0.0.5').kind).toBe('reconfirm');
    const p1 = item({
      audit: { level: 'p1', rulesVersion: 'r1', network: [], commands: [], hooks: false },
    });
    expect(decideUpdate(installed, index([p1]), '0.0.5').kind).toBe('reconfirm');
  });

  it('stdio 连接器的任何新版本都要重新确认，哪怕声明的能力一样', () => {
    const conn: HubInstalled = { ...installed, kind: 'connector', transport: 'stdio' };
    const next = item({ kind: 'connector', connector: { transport: 'stdio' } });
    expect(decideUpdate(conn, index([next]), '0.0.5').kind).toBe('reconfirm');
  });

  it('已装版本被吊销 → 立即停用（优先于一切）', () => {
    const d = decideUpdate(
      installed,
      index([item()], [{ id: 'minutes', versions: ['<1.0.1'], reason: '诱导安装外部程序' }]),
      '0.0.5',
    );
    expect(d).toEqual({ kind: 'revoked', reason: '诱导安装外部程序' });
  });

  it('新版本要求更高的 App → 不更新，提示需要更新 EvoWork', () => {
    const d = decideUpdate(installed, index([item({ minAppVersion: '0.1.0' })]), '0.0.5');
    expect(d.kind).toBe('needs-app-update');
  });

  it('索引里的版本不比已装的新 → 什么都不做', () => {
    expect(decideUpdate(installed, index([item({ version: '1.0.0' })]), '0.0.5').kind).toBe('none');
  });
});

describe('本地重审与云端结论（13 §5.3，HUB-Q9=A）', () => {
  const cloud = item().audit;

  it('规则版本相同、结论不同 → 拒装（内容或索引被动过）', () => {
    const r = reconcileAudit(
      { ...cloud, rulesVersion: AUDIT_RULES_VERSION },
      { level: 'p1', network: [], commands: ['run.py'], hooks: false },
    );
    expect(r.ok).toBe(false);
  });

  it('规则版本不同 → 取更严的，能力取并集，不拒装', () => {
    const r = reconcileAudit(
      { ...cloud, rulesVersion: 'older', network: ['a.com'] },
      { level: 'p1', network: ['b.com'], commands: [], hooks: false },
    );
    expect(r.ok && r.level).toBe('p1');
    expect(r.ok && r.capabilities.network).toEqual(['a.com', 'b.com']);
  });
});

describe('目录状态（13 §5.6）', () => {
  const base = { appVersion: '0.0.5', now: 100_000_000, expired: false };

  it('索引过期：没装的不许新装，已装的不受影响', () => {
    const entries = hubEntries({
      ...base,
      expired: true,
      index: index([item(), item({ id: 'other' })]),
      installed: { items: [installed] },
    });
    expect(entries.find((e) => e.id === 'other')?.state).toBe('expired');
    expect(entries.find((e) => e.id === 'minutes')?.state).toBe('installed');
  });

  it('装着、但索引里没有了 → 照样列出来，能卸载', () => {
    const entries = hubEntries({ ...base, index: index([]), installed: { items: [installed] } });
    expect(entries.map((e) => [e.id, e.state])).toEqual([['minutes', 'installed']]);
  });

  it('没装、最新版被吊销 → 不列', () => {
    const entries = hubEntries({
      ...base,
      index: index([item()], [{ id: 'minutes', versions: ['*'], reason: 'x' }]),
      installed: { items: [] },
    });
    expect(entries).toEqual([]);
  });

  it('「新上架」只标两周内、还没装的', () => {
    const entries = hubEntries({
      ...base,
      index: index([item({ publishedAt: base.now - 3600 }), item({ id: 'old', publishedAt: 1 })]),
      installed: { items: [] },
    });
    expect(entries.find((e) => e.id === 'minutes')?.isNew).toBe(true);
    expect(entries.find((e) => e.id === 'old')?.isNew).toBe(false);
  });

  it('本机记录读写往返', () => {
    const state = upsertInstalled(
      { items: [] },
      {
        ...installed,
        previous: { version: '0.9.0', level: 'p0', network: [], commands: [], hooks: false },
      },
    );
    expect(parseHubInstallState(serializeHubInstallState(state))).toEqual(state);
  });
});

describe('能力面与 prompt 预算', () => {
  it('能力面：域名、脚本、hooks', () => {
    const caps = extractCapabilities([
      { relativePath: 'SKILL.md', text: '调用 https://api.example.com/v1 拿数据' },
      { relativePath: 'scripts/run.py', text: '' },
      { relativePath: 'hooks/hooks.json', text: '{}' },
    ]);
    expect(caps).toEqual({
      network: ['api.example.com'],
      commands: ['scripts/run.py'],
      hooks: true,
    });
    expect(capabilityGrowth({ level: 'p0', ...caps }, { level: 'p0', ...caps })).toEqual([]);
  });

  it('成本口径与内核一致：一行 `- name: desc (file: path)`，4 字节 ≈ 1 token', () => {
    // 13 §12 V3：7 个随包技能装在 /Applications/EvoWork.app 下时合计 489
    expect(skillCatalogCost([{ name: 'a', description: 'bc', path: '/p' }])).toBe(
      Math.ceil(Buffer.byteLength('- a: bc (file: /p)\n') / 4),
    );
    expect(skillCatalogBudget(128_000)).toBe(2560);
  });
});

describe('K6：catalog 里**没有出网路径**（13 §4.6 / §5.1）', () => {
  it('整个 src 扫不出 fetch / http，也不依赖 hub-client', () => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(files.length, '一个文件都没扫到说明路径错了').toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), 'utf8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      );
      for (const forbidden of [
        'fetch(',
        'node:http',
        'node:https',
        'node:net',
        'XMLHttpRequest',
        'WebSocket',
        '@evowork/hub-client',
      ]) {
        expect(source, `${file} 不该出现 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
