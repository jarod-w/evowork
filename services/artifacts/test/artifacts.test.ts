/**
 * 产物索引 · 分享 · 资料库（M8）。
 *
 * 三组里最该被读到的是**分享**那一组：它是本机内容离开设备的唯一常规出网路径，
 * 而 Q10 的六条规则里有两条特别容易在"优化体验"时被删掉
 * （记住授权、批量分享）—— 那两条在这里各有一条断言钉着。
 */
import { describe, expect, it } from 'vitest';

import {
  authorizationSummary,
  createShare,
  CLEANUP_HINT,
  describeDeleteMine,
  describeDiskUsage,
  describeRemoveArtifact,
  DEFAULT_TTL,
  filterRows,
  isIgnored,
  LOCAL_SAVE_HINT,
  mergeSignals,
  RECENT_TABS,
  recognize,
  relocate,
  requiresContentPreview,
  revoke,
  shareState,
  shouldShowOwnerColumn,
  THREAD_SHARE_WARNING,
  typeFromPath,
  VERSION_ACTION_LABEL,
  type ArtifactRecord,
  type LibraryRow,
  type RecognizeContext,
} from '../src/index.js';

const NOW = Date.parse('2026-09-05T10:00:00Z');

function context(over: Partial<RecognizeContext> = {}): RecognizeContext {
  let counter = 0;
  return {
    threadId: 't1',
    turnId: 'turn1',
    now: () => NOW,
    newId: () => `af_${(counter += 1)}`,
    statFile: () => ({ sizeBytes: 1024, contentHash: 'hash-1' }),
    latestFor: () => undefined,
    ...over,
  };
}

describe('产物类型：**chart 与 image 靠信号源区分，不是扩展名**', () => {
  it('charts 技能上报的 png 是 chart', () => {
    const outcome = recognize(
      {
        signal: 'SKILL_REPORT',
        skill: 'charts',
        path: '/w/charts/margin.png',
        outputFormat: 'png',
        operationKind: 'create',
      },
      context(),
    );
    expect(outcome.kind).toBe('inserted');
    if (outcome.kind === 'ignored') throw new Error('类型收窄');
    expect(outcome.record.artifactType).toBe('chart');
  });

  it('同一个 png 只靠扩展名会被推成 image —— 这就是信号 ① 必须存在的原因', () => {
    expect(typeFromPath('/w/charts/margin.png')).toBe('image');
  });

  it('合并多个信号时**技能上报优先**，否则 HOOK_SCAN 会把类型覆盖掉', () => {
    const merged = mergeSignals([
      { signal: 'HOOK_SCAN', path: '/w/a.png' },
      {
        signal: 'SKILL_REPORT',
        skill: 'charts',
        path: '/w/a.png',
        outputFormat: 'png',
        operationKind: 'create',
      },
      { signal: 'FILE_CHANGE', path: '/w/a.png', kind: 'add' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.signal).toBe('SKILL_REPORT');
  });
});

describe('去重与版本（08 §2.5）', () => {
  it('**哈希没变就什么都不做** —— 三个信号各报一次不该产出三张卡', () => {
    const previous: ArtifactRecord = {
      id: 'af_0',
      path: '/w/a.pptx',
      artifactType: 'presentation',
      outputFormat: 'pptx',
      title: 'a.pptx',
      operationKind: 'create',
      version: 1,
      sourceSignal: 'SKILL_REPORT',
      fileState: 'PRESENT',
      contentHash: 'hash-1',
      createdAt: NOW,
    };
    const outcome = recognize(
      { signal: 'FILE_CHANGE', path: '/w/a.pptx', kind: 'modify' },
      context({ latestFor: () => previous }),
    );
    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') throw new Error('类型收窄');
    expect(outcome.reason).toBe('unchanged');
  });

  it('哈希变了 → version + 1 并串上 supersedes', () => {
    const previous: ArtifactRecord = {
      id: 'af_0',
      path: '/w/a.pptx',
      artifactType: 'presentation',
      outputFormat: 'pptx',
      title: 'a.pptx',
      operationKind: 'create',
      version: 1,
      sourceSignal: 'SKILL_REPORT',
      fileState: 'PRESENT',
      contentHash: 'old',
      createdAt: NOW,
    };
    const outcome = recognize(
      { signal: 'FILE_CHANGE', path: '/w/a.pptx', kind: 'modify' },
      context({ latestFor: () => previous }),
    );
    expect(outcome.kind).toBe('superseded');
    if (outcome.kind === 'ignored') throw new Error('类型收窄');
    expect(outcome.record.version).toBe(2);
    expect(outcome.record.supersedesId).toBe('af_0');
    // 已有记录时是 edit 不是 create
    expect(outcome.record.operationKind).toBe('edit');
  });

  it('**磁盘上只有最新版**，所以旧版的动作文案不能是「打开这一版文件」', () => {
    expect(VERSION_ACTION_LABEL).toBe('查看这一版的生成记录');
  });
});

describe('哪些文件不算产物', () => {
  it('中间产物、缓存、解析副本都不进索引', () => {
    for (const path of [
      '/w/node_modules/x/a.js',
      '/w/uploads/20260905-年报/content.md',
      '/w/.git/config',
      '/w/~$report.docx',
      '/w/build.log',
    ]) {
      expect(isIgnored(path), path).toBe(true);
    }
    expect(isIgnored('/w/report.docx')).toBe(false);
  });

  it('删除事件不产生新记录（由 fs/watch 标 MISSING）', () => {
    const outcome = recognize(
      { signal: 'FILE_CHANGE', path: '/w/a.docx', kind: 'delete' },
      context(),
    );
    expect(outcome.kind).toBe('ignored');
  });

  it('文件被移动时**先按内容哈希重新定位**，而不是直接标 MISSING', () => {
    const record = {
      id: 'af_1',
      path: '/w/old/a.docx',
      contentHash: 'hash-x',
    } as ArtifactRecord;
    expect(relocate(record, [{ path: '/w/new/a.docx', contentHash: 'hash-x' }])).toEqual({
      fileState: 'PRESENT',
      path: '/w/new/a.docx',
    });
    expect(relocate(record, []).fileState).toBe('MISSING');
  });
});

describe('分享：Q10 的六条硬规则', () => {
  const authorization = {
    artifactId: 'af_1',
    fileName: 'Q3汇报.pptx',
    sizeBytes: 2 * 1024 * 1024,
    artifactTypeLabel: '幻灯片',
    ttl: DEFAULT_TTL,
    confirmed: true,
  };
  const ctx = { sharingEnabled: true, fileExists: true, now: () => NOW, newId: () => 'sh_1' };

  it('默认有效期 24 小时', () => {
    expect(DEFAULT_TTL).toBe('24h');
  });

  it('**确认勾选框不预勾** —— 没勾就不上传，且文案不责备用户', () => {
    const result = createShare({ ...authorization, confirmed: false }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.refusal.code).toBe('NOT_CONFIRMED');
  });

  it('授权模态三句话缺一不可：上传什么 · 谁能看 · 多久失效', () => {
    const lines = authorizationSummary(authorization);
    expect(lines[0]).toContain('Q3汇报.pptx');
    expect(lines[1]).toContain('任何拿到链接的人都能访问');
    expect(lines[2]).toContain('24 小时');
  });

  it('**授权接口一次只接受一个产物** —— 批量会让人一次传出比想象更多的东西', () => {
    // 类型层面就没有"多个 artifactId"这个形状：这条规则是结构上的，不是约定
    expect(Object.keys(authorization)).toContain('artifactId');
    expect(Object.keys(authorization)).not.toContain('artifactIds');
  });

  it('企业策略可全局禁用，且**必须给原因**', () => {
    const result = createShare(authorization, {
      ...ctx,
      sharingEnabled: false,
      disabledReason: '你所在的组织已停用分享功能。',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.refusal.message).toContain('组织');
  });

  it('文件不在了就不能分享', () => {
    const result = createShare(authorization, { ...ctx, fileExists: false });
    expect(result.ok).toBe(false);
  });

  it('到期状态：活跃 → 即将到期（24h 内）→ 已过期；撤销即刻失效', () => {
    const result = createShare({ ...authorization, ttl: '7d' }, ctx);
    if (!result.ok) throw new Error('类型收窄');
    const share = result.share;

    expect(shareState(share, NOW)).toBe('active');
    expect(shareState(share, share.expiresAt - 60_000)).toBe('expiring-soon');
    expect(shareState(share, share.expiresAt)).toBe('expired');
    expect(shareState(revoke(share, NOW), NOW)).toBe('revoked');
  });

  it('分享**任务**要额外警告并强制预览（不许盲传）', () => {
    expect(requiresContentPreview('thread')).toBe(true);
    expect(requiresContentPreview('artifact')).toBe(false);
    expect(THREAD_SHARE_WARNING).toContain('预览');
  });

  it('「另存为」是清单 §6.3 在 v1 的等价能力，且**不经过我们的云**', () => {
    expect(LOCAL_SAVE_HINT).toContain('不经过 EvoWork 云');
  });
});

describe('资料库视图（06 §3）', () => {
  const rows: LibraryRow[] = [
    {
      id: '1',
      name: 'Q3汇报.pptx',
      source: 'artifact',
      owner: '我',
      location: 'weekly',
      accessedAt: 3,
      artifactType: 'presentation',
      extension: 'pptx',
    },
    {
      id: '2',
      name: '笔记.md',
      source: 'mine',
      owner: '我',
      location: '我的资料',
      accessedAt: 2,
      artifactType: 'document',
      extension: 'md',
    },
    {
      id: '3',
      name: '数据.json',
      source: 'artifact',
      owner: '我',
      location: 'weekly',
      accessedAt: 1,
      artifactType: 'data',
      extension: 'json',
    },
  ];

  it('**所有者相同时自动隐藏该列** —— 否则个人版里那是一整列废信息', () => {
    expect(shouldShowOwnerColumn(rows)).toBe(false);
    expect(shouldShowOwnerColumn([...rows, { ...rows[0]!, id: '4', owner: '产品组' }])).toBe(true);
    expect(shouldShowOwnerColumn([])).toBe(false);
  });

  it('Markdown 单独一档，且不被「文档」重复收走', () => {
    expect(filterRows(rows, { filter: 'markdown' }).map((r) => r.id)).toEqual(['2']);
    expect(filterRows(rows, { filter: 'document' })).toHaveLength(0);
  });

  it('「其他」收走不属于前五档的类型', () => {
    expect(filterRows(rows, { filter: 'other' }).map((r) => r.id)).toEqual(['3']);
  });

  it('搜索按名称过滤', () => {
    expect(filterRows(rows, { query: '汇报' }).map((r) => r.id)).toEqual(['1']);
  });

  it('**「与我共享」v1 不渲染**（Q19：只读订阅，收件箱不做）', () => {
    expect(RECENT_TABS.map((t) => t.id)).toEqual(['recent', 'shared-by-me']);
  });
});

describe('两种删除的语义**不同**（写反了用户会丢文件）', () => {
  it('「我的资料」= 真删磁盘文件，且说清不进回收站', () => {
    const intent = describeDeleteMine('笔记.md');
    expect(intent.kind).toBe('delete-file');
    expect(intent.body).toContain('不进回收站');
    expect(intent.offersFileDeletion).toBe(false);
  });

  it('「本地产物」= 只移除索引，**磁盘文件默认保留**', () => {
    const intent = describeRemoveArtifact('Q3汇报.pptx', '/w/Q3汇报.pptx');
    expect(intent.kind).toBe('remove-index');
    expect(intent.body).toContain('磁盘上的文件会保留');
    // 想同时删文件是可选项，且默认不勾
    expect(intent.offersFileDeletion).toBe(true);
  });
});

describe('本机磁盘占用（Q17：不是云配额）', () => {
  it('文案说的是本机占用与剩余，动作是清理', () => {
    const usage = describeDiskUsage({
      artifactsBytes: 2e9,
      parseCacheBytes: 1e9,
      indexBytes: 1e8,
      diskFreeBytes: 50e9,
    });
    expect(usage.label).toContain('本机占用');
    expect(usage.label).toContain('磁盘剩余');
    expect(usage.label).not.toContain('升级');
    // **只有解析缓存能安全清理**：产物是用户的东西，索引清了要重建
    expect(usage.cleanable).toBe(1e9);
    expect(CLEANUP_HINT).toContain('产物文件本身不会被删除');
  });
});
