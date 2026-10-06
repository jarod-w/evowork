import { describe, expect, it } from 'vitest';
import {
  mergeWebSources,
  webResearchResult,
  webSourcesByItem,
  type WebSource,
} from '../src/shared/web-sources.js';

export const WEB_FIXTURE: WebSource = {
  id: 'web_0123456789abcdef',
  url: 'https://example.test/report',
  title: '官方报告',
  kind: 'search',
  retrievedAt: '2026-10-06T04:00:00.000Z',
  excerpt: '报告摘要',
  truncated: false,
};
export function webItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'search-1',
    type: 'mcpToolCall',
    server: 'browser',
    tool: 'browser_search',
    status: 'completed',
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            evoworkWeb: 1,
            ok: true,
            kind: 'search',
            query: '公开报告',
            sources: [WEB_FIXTURE],
          }),
        },
      ],
    },
    ...overrides,
  };
}
describe('来源必须由本任务成功工具结果取得', () => {
  it('实时与恢复历史读取同一来源；后来的搜索不会给较早消息背书', () => {
    const byItem = webSourcesByItem([
      { id: 'early', type: 'agentMessage' },
      webItem(),
      { id: 'reply', type: 'agentMessage' },
    ]);
    expect(byItem.get('early')).toEqual([]);
    expect(byItem.get('reply')).toEqual([WEB_FIXTURE]);
    expect(webResearchResult(webItem())?.sources).toEqual([WEB_FIXTURE]);
  });
  it.each([
    { status: 'inProgress' },
    { server: 'other' },
    { type: 'agentMessage' },
    { tool: 'browser_snapshot' },
    { error: { message: '失败' } },
  ])('进行中、失败和其它工具不能建立来源 %j', (overrides) => {
    expect(webResearchResult(webItem(overrides))).toBeUndefined();
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.test'])(
    '来源 URL 不得打开 %s',
    (url) => {
      const item = webItem({
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                evoworkWeb: 1,
                ok: true,
                kind: 'search',
                sources: [{ ...WEB_FIXTURE, url }],
              }),
            },
          ],
        },
      });
      expect(webResearchResult(item)).toBeUndefined();
    },
  );
  it('搜索摘要不能覆盖已经读取的正文，同一 URL 读取更新可刷新', () => {
    const page = { ...WEB_FIXTURE, kind: 'page' as const, excerpt: '已读正文' };
    expect(mergeWebSources([page], [WEB_FIXTURE])).toEqual([page]);
    expect(mergeWebSources([WEB_FIXTURE], [page])).toEqual([page]);
  });
});
