/**
 * 分享页的行为（Q41 / 08 §7.4）。
 *
 * 断言写**后果**：办公文件给出预览 = 把不可信文件当网页跑；
 * 失效页显示类型和大小 = 拿链接就能探测；PDF 的 iframe 给了 `allow-same-origin`
 * = 一份不可信文件拿到了这一页的源。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  fallbackName,
  fileNameFromHash,
  formatRemaining,
  shareIdFromPath,
  typeLabel,
} from '../src/share/api.js';
import { SharePage } from '../src/share/page.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ID = 'shr_abc';

function mockShare(view: unknown, extra: Record<string, unknown> = {}) {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith(`/v1/s/${ID}`)) {
      return new Response(JSON.stringify(view), { status: 200 });
    }
    if (url.endsWith('/unlock')) {
      const body = extra.unlock ?? { ok: false };
      return new Response(JSON.stringify(body), {
        status: (body as { ok?: boolean }).ok === true ? 200 : 403,
      });
    }
    if (url.endsWith('/blob')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  return fetchMock;
}

const ACTIVE_DOCX = {
  state: 'active',
  meta: {
    id: ID,
    contentType: DOCX,
    sizeBytes: 12345,
    expiresAt: Date.now() + 6 * 3600_000,
    hasPassword: false,
    previewable: false,
  },
};

describe('链接解析', () => {
  it('只认 /s/<id>', () => {
    expect(shareIdFromPath('/s/shr_abc')).toBe('shr_abc');
    expect(shareIdFromPath('/s/shr_abc/')).toBe('shr_abc');
    expect(shareIdFromPath('/admin')).toBeUndefined();
    expect(shareIdFromPath('/s/../../etc/passwd')).toBeUndefined();
  });

  it('文件名来自片段，且挡掉路径分隔符与控制字符', () => {
    expect(fileNameFromHash('#%E5%91%A8%E6%8A%A5.docx')).toBe('周报.docx');
    expect(fileNameFromHash('')).toBeUndefined();
    expect(fileNameFromHash('#../../etc/passwd')).toBeUndefined();
    expect(fileNameFromHash('#a\u0000b')).toBeUndefined();
  });

  it('片段没带名字时仍然能下载，只是用兜底名', () => {
    expect(fallbackName(ID, DOCX)).toBe('shr_abc.docx');
    expect(fallbackName(ID, 'application/pdf')).toBe('shr_abc.pdf');
  });

  it('类型标签说人话', () => {
    expect(typeLabel(DOCX)).toBe('Word 文档');
    expect(typeLabel('application/pdf')).toBe('PDF');
    expect(typeLabel('application/x-weird')).toBe('文件');
  });

  it('有效期只给粗粒度', () => {
    const now = 1_700_000_000_000;
    expect(formatRemaining(now + 50 * 3600_000, now)).toBe('2 天后失效');
    expect(formatRemaining(now + 3 * 3600_000, now)).toBe('3 小时后失效');
    expect(formatRemaining(now - 1, now)).toBe('已过期');
  });
});

describe('办公文件（Q41 的那一条）', () => {
  it('只给元数据 + 下载，**没有预览**', async () => {
    mockShare(ACTIVE_DOCX);
    render(<SharePage pathname={`/s/${ID}`} hash="#%E5%91%A8%E6%8A%A5.docx" />);
    await waitFor(() => {
      expect(screen.getByText('周报.docx')).toBeTruthy();
    });
    expect(screen.getByText('Word 文档')).toBeTruthy();
    expect(screen.getByText('12 KB')).toBeTruthy();
    expect(screen.getByText('下载')).toBeTruthy();
    // 页面上不该有任何 iframe 或 img 预览
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/办公文件不在浏览器里打开/)).toBeTruthy();
  });

  it('「在 EvoWork 中打开」走 evowork:// 协议，并如实说它可能没用', async () => {
    mockShare(ACTIVE_DOCX);
    render(<SharePage pathname={`/s/${ID}`} hash="" />);
    const link = (await screen.findByText('在 EvoWork 中打开')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`evowork://share/${ID}`);
    expect(screen.getByText(/不会把文件同步过来/)).toBeTruthy();
  });

  it('片段没带名字时说清楚，而不是显示一个假名字', async () => {
    mockShare(ACTIVE_DOCX);
    render(<SharePage pathname={`/s/${ID}`} hash="" />);
    await waitFor(() => {
      expect(screen.getByText('（文件名未随链接传来）')).toBeTruthy();
    });
    expect(screen.getByText('下载')).toBeTruthy();
  });
});

describe('可预览的类型', () => {
  it('PDF 用沙箱 iframe，且**不给 allow-same-origin**', async () => {
    mockShare({
      state: 'active',
      meta: {
        id: ID,
        contentType: 'application/pdf',
        sizeBytes: 100,
        expiresAt: Date.now() + 3600_000,
        hasPassword: false,
        previewable: true,
      },
    });
    render(<SharePage pathname={`/s/${ID}`} hash="#a.pdf" />);
    await waitFor(() => {
      expect(document.querySelector('iframe')).not.toBeNull();
    });
    const frame = document.querySelector('iframe')!;
    // 空 sandbox = 什么都不许；给了 allow-same-origin 就等于把这一页的源交出去
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
});

describe('失效页', () => {
  it.each([
    ['expired', '这个链接已经过期'],
    ['revoked', '这个分享已经被撤销'],
    ['missing', '找不到这个分享'],
  ])('%s：只给一句话，不给类型与大小', async (state, title) => {
    mockShare({ state });
    render(<SharePage pathname={`/s/${ID}`} hash="#a.docx" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    });
    expect(screen.queryByText('Word 文档')).toBeNull();
    expect(screen.queryByText('下载')).toBeNull();
  });
});

describe('访问密码', () => {
  it('密码只挡住拿文件，**不因此开通办公文件预览**', async () => {
    mockShare(
      {
        state: 'active',
        meta: { ...ACTIVE_DOCX.meta, hasPassword: true },
      },
      { unlock: { ok: true, grant: 'g1' } },
    );
    render(<SharePage pathname={`/s/${ID}`} hash="#a.docx" />);
    await waitFor(() => {
      expect(screen.getByLabelText('这个分享设了访问密码')).toBeTruthy();
    });
    // 解锁之前没有下载
    expect(screen.queryByText('下载')).toBeNull();

    fireEvent.change(screen.getByLabelText('这个分享设了访问密码'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByText('解锁'));

    await waitFor(() => {
      expect(screen.getByText('下载')).toBeTruthy();
    });
    // 解锁之后它依然是不可预览的 docx
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/办公文件不在浏览器里打开/)).toBeTruthy();
  });

  it('明文密码不离开浏览器：发出去的是哈希', async () => {
    const fetchMock = mockShare(
      { state: 'active', meta: { ...ACTIVE_DOCX.meta, hasPassword: true } },
      { unlock: { ok: true, grant: 'g1' } },
    );
    render(<SharePage pathname={`/s/${ID}`} hash="#a.docx" />);
    fireEvent.change(await screen.findByLabelText('这个分享设了访问密码'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByText('解锁'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/unlock'))).toBe(true);
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/unlock'));
    const body = String(call?.[1]?.body ?? '');
    expect(body).not.toContain('hunter2');
    expect(body).toMatch(/"passwordHash":"[0-9a-f]{64}"/);
  });

  it('密码错时不区分「错」与「失效」 —— 区分开就能拿来枚举', async () => {
    mockShare(
      { state: 'active', meta: { ...ACTIVE_DOCX.meta, hasPassword: true } },
      { unlock: { ok: false } },
    );
    render(<SharePage pathname={`/s/${ID}`} hash="#a.docx" />);
    fireEvent.change(await screen.findByLabelText('这个分享设了访问密码'), {
      target: { value: 'nope' },
    });
    fireEvent.click(screen.getByText('解锁'));
    await waitFor(() => {
      expect(screen.getByText('密码不对，或者这个链接已经失效了。')).toBeTruthy();
    });
  });
});

describe('坏链接', () => {
  it('地址里没有分享编号时说清楚', async () => {
    mockShare({ state: 'missing' });
    render(<SharePage pathname="/nonsense" hash="" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '这个链接不对' })).toBeTruthy();
    });
  });

  it('连不上分享服务时不把它说成「已失效」', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    render(<SharePage pathname={`/s/${ID}`} hash="" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '打不开这个链接' })).toBeTruthy();
    });
  });
});
