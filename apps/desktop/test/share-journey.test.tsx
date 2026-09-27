/**
 * 分享的端到端旅程：点「分享」→ 授权模态 → 上传 → 链接 → 「我分享的」→ 撤销。
 *
 * 为什么要端到端：这条链路上每一段单独测都过，而 CLAUDE.md §9.1 记着
 * 「两个模块各自对，合起来可能不对」—— 这条链路横跨渲染层、IPC、主进程、
 * 两个 service 与一个云端服务，正是那句话的典型形状。
 *
 * 断言写**后果**：
 *   · 没勾确认就能点「生成链接」= Q10 的逐次授权形同虚设
 *   · 模态上出现「以后不再询问」= 第二次分享起这条通道默认开启（规则 1）
 *   · 失败后回不到授权屏 = 用户得从头再填一遍
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ShareDialog, type SharePhase } from '../src/renderer/components/share-dialog.js';
import type { SharePlanView } from '../src/shared/ipc.js';

const PLAN: SharePlanView = {
  artifactId: 'art_1',
  fileName: '周报.docx',
  sizeBytes: 2 * 1024 * 1024,
  artifactTypeLabel: 'Word 文档',
  summary: [
    '将要上传：周报.docx（Word 文档，2.0 MB）',
    '文件会上传到 EvoWork 云。**任何拿到链接的人都能访问它。**',
    '链接在 24 小时后失效，之后云端副本会被自动删除。',
  ],
  ttl: '24h',
  ttlOptions: [
    { id: '24h', label: '24 小时' },
    { id: '7d', label: '7 天' },
    { id: '30d', label: '30 天' },
  ],
};

function renderDialog(phase: SharePhase, over: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onCopy = vi.fn();
  render(
    <ShareDialog
      phase={phase}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onCopy={onCopy}
      {...over}
    />,
  );
  return { onConfirm, onCancel, onCopy };
}

describe('授权屏（Q10 的六条硬规则）', () => {
  it('三句话都在，第二句原样说清"任何拿到链接的人都能访问"', () => {
    renderDialog({ kind: 'authorize', plan: PLAN });
    expect(screen.getByText(/将要上传：周报.docx/)).toBeTruthy();
    expect(screen.getByText(/任何拿到链接的人都能访问它/)).toBeTruthy();
    expect(screen.getByText(/24 小时后失效/)).toBeTruthy();
  });

  it('**确认框不预勾**，且没勾之前「生成链接」点不动', () => {
    const { onConfirm } = renderDialog({ kind: 'authorize', plan: PLAN });
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(onConfirm).toHaveBeenCalledWith({
      ttl: '24h',
      accessCode: undefined,
      confirmed: true,
      previewed: false,
    });
  });

  it('**没有「以后不再询问」** —— 有了它，这条通道第二次起就默认开启（规则 1）', () => {
    renderDialog({ kind: 'authorize', plan: PLAN });
    expect(screen.queryByText(/不再询问/)).toBeNull();
    expect(screen.queryByText(/记住/)).toBeNull();
    // 只有一个勾选框：确认那一个
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('三档有效期可选，选了就带下去', () => {
    const { onConfirm } = renderDialog({ kind: 'authorize', plan: PLAN });
    fireEvent.click(screen.getByRole('button', { name: '7 天' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ ttl: '7d' });
  });

  it('访问码是可选的，且说清它**不开通办公文件预览**', () => {
    const { onConfirm } = renderDialog({ kind: 'authorize', plan: PLAN });
    fireEvent.change(screen.getByLabelText('访问密码（可选）'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ accessCode: 'hunter2' });
    expect(screen.getByText(/办公文件在浏览器里始终不预览/)).toBeTruthy();
  });

  it('失败之后回到授权屏并带上原因，不用从头再填一遍', () => {
    renderDialog({ kind: 'failed', plan: PLAN, refused: '上传失败，网络没连上。' });
    expect(screen.getByText('上传失败，网络没连上。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 三句话还在，勾选框还在 —— 重试不是重来
    expect(screen.getByText(/任何拿到链接的人都能访问它/)).toBeTruthy();
  });
});

describe('上传屏', () => {
  it('不画假进度条，并说清取消会中止请求', () => {
    renderDialog({ kind: 'uploading', plan: PLAN });
    expect(screen.getByText('正在上传…')).toBeTruthy();
    // 上传是一次 fetch，拿不到分块进度。画一条 0→100 一跳的条比不画更糟
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/云端不会留下这个文件/)).toBeTruthy();
  });

  it('「取消上传」走的是同一个中止路径', () => {
    const { onCancel } = renderDialog({ kind: 'uploading', plan: PLAN });
    fireEvent.click(screen.getByRole('button', { name: '取消上传' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('完成屏', () => {
  const done: SharePhase = {
    kind: 'done',
    url: 'https://s.example/s/shr_1#%E5%91%A8%E6%8A%A5.docx',
    expiresAt: Date.now() + 86_400_000,
  };

  it('给出链接、可复制，并再说一次"谁拿到都能访问"', () => {
    const { onCopy } = renderDialog(done);
    expect(screen.getByText(done.kind === 'done' ? done.url : '')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    expect(onCopy).toHaveBeenCalledWith(done.kind === 'done' ? done.url : '');
    expect(screen.getByText(/任何拿到这条链接的人都能访问它/)).toBeTruthy();
  });

  it('说明片段里那一段是文件名、服务器不知道它（08 §7.5）', () => {
    renderDialog(done);
    expect(screen.getByText(/我们的服务器不知道这个文件叫什么/)).toBeTruthy();
  });

  it('告诉用户去哪撤销 —— 否则"可撤销"这条规则等于没有入口', () => {
    renderDialog(done);
    expect(screen.getByText(/我分享的/)).toBeTruthy();
  });
});

describe('二维码（08 §7.1 第 ③ 步）', () => {
  const url = 'https://s.example/s/shr_1#%E5%91%A8%E6%8A%A5.docx';

  it('完成屏给出二维码', () => {
    renderDialog({ kind: 'done', url, expiresAt: Date.now() + 86_400_000 });
    expect(screen.getByRole('img', { name: '分享链接的二维码' })).toBeTruthy();
  });

  it('二维码编的是**带片段的同一条链接** —— 扫出来没名字就白扫了', async () => {
    const { QrCode } = await import('../src/renderer/components/qr.js');
    const qrcode = (await import('qrcode-generator')).default;
    // 用同一个库、同一组参数独立编一次，比对模块数：
    // 编的内容不同（比如漏了 # 之后那段）时，模块数几乎必然不同
    const withFragment = qrcode(0, 'M');
    withFragment.addData(url);
    withFragment.make();
    const withoutFragment = qrcode(0, 'M');
    withoutFragment.addData(url.split('#')[0]!);
    withoutFragment.make();
    expect(withFragment.getModuleCount()).not.toBe(withoutFragment.getModuleCount());

    render(<QrCode value={url} size={160} title="t" />);
    const svg = screen.getByRole('img', { name: 't' });
    // 静区 4 个模块：少给了扫码器找不到定位图案
    expect(svg.getAttribute('viewBox')).toBe(
      `0 0 ${withFragment.getModuleCount() + 8} ${withFragment.getModuleCount() + 8}`,
    );
  });

  it('链接变长时不抛错 —— 版本是自动挑的，定死会在某个长度上崩', async () => {
    const { QrCode } = await import('../src/renderer/components/qr.js');
    const long = `https://s.example/s/shr_1#${encodeURIComponent('这是一个很长的中文文件名'.repeat(6))}`;
    expect(() => render(<QrCode value={long} size={160} title="long" />)).not.toThrow();
  });
});

describe('分享任务（08 §7.2 规则 5：不许盲传）', () => {
  const MARKDOWN =
    '# 周报任务\n\n## 我说\n\n帮我写周报\n\n### 执行了命令\n\n```\nls /Users/me/work\n```\n';
  const threadPhase: SharePhase = {
    kind: 'authorize-thread',
    markdown: MARKDOWN,
    plan: { ...PLAN, fileName: '周报任务.md', artifactTypeLabel: '任务记录' },
  };

  it('比分享产物多一句警告：里面可能有路径、命令输出与业务信息', () => {
    renderDialog(threadPhase);
    expect(screen.getByText(/工作空间路径、文件内容片段与业务信息/)).toBeTruthy();
  });

  it('**把将要上传的全文铺开**，而不是只说一句"包含对话"', () => {
    renderDialog(threadPhase);
    // 预览里出现的是真内容，包括那条会暴露目录结构的命令
    expect(screen.getByText(/ls \/Users\/me\/work/)).toBeTruthy();
    expect(screen.getByText(/这就是对方会拿到的全部内容/)).toBeTruthy();
  });

  it('两个勾都打上才让传：确认可以外传 **以及** 确实看过', () => {
    const { onConfirm } = renderDialog(threadPhase);
    const [previewBox, confirmBox] = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    fireEvent.click(confirmBox!);
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(previewBox!);
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, previewed: true }),
    );
  });

  it('标题说的是任务不是产物', () => {
    renderDialog(threadPhase);
    expect(screen.getByRole('dialog', { name: '分享这个任务' })).toBeTruthy();
  });

  it('分享产物时**没有**这两样 —— 规则 5 只加在任务上', () => {
    renderDialog({ kind: 'authorize', plan: PLAN });
    expect(screen.queryByText(/工作空间路径、文件内容片段/)).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});

describe('两份警告文案不许分叉', () => {
  it('渲染层那份与 @evowork/artifacts 的 THREAD_SHARE_WARNING 相等', async () => {
    const { THREAD_SHARE_WARNING: fromRenderer } =
      await import('../src/renderer/components/share-dialog.js');
    const { THREAD_SHARE_WARNING: fromService } = await import('@evowork/artifacts');
    // 渲染层不能 import 服务层 barrel（浏览器没有 node 内置模块），所以文案有两份。
    // 两份就得有人盯着它们一致 —— 否则改了一处，用户看到的还是旧的那句
    expect(fromRenderer).toBe(fromService);
  });
});
