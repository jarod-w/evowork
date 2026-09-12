/**
 * 项目详情页（02 §4.3，三栏）。
 *
 * 三条要守住的：**文件树默认折叠噪声目录但不隐藏**、
 * **失效横幅不静默**、**AGENTS.md 不存在与内容为空是两回事**。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectDetailPage } from '../src/renderer/views/project-detail.js';
import type { AgentsMemoView, DirEntryView, ProjectDetailView } from '../src/shared/ipc.js';

const DETAIL: ProjectDetailView = {
  id: 'p1',
  name: '季度汇报',
  rootDisplay: '~/w/q3',
  rootMissing: false,
  tasks: [
    {
      id: 't1',
      title: '写周报',
      status: 'completed',
      timeLabel: '2 小时前',
      updatedAt: Date.now(),
      sectionId: 'recent',
    },
  ],
  fileActions: [{ id: 'a1', name: 'report.docx', action: 'document', at: 1_700_000_000_000 }],
  automations: [{ id: 'au1', name: '每周一汇总', schedule: '0 9 * * 1', status: 'ACTIVE' }],
};

const ROOT_ENTRIES: readonly DirEntryView[] = [
  { name: 'src', path: '/w/q3/src', isDirectory: true, noisy: false },
  { name: 'node_modules', path: '/w/q3/node_modules', isDirectory: true, noisy: true },
  // 特意与主区「最近的文件动作」里的文件名不同（那边是 report.docx）——
  // 树里的文件与主区表格里的文件同名是完全合理的真实场景，但会让下面按文本查找的
  // 断言产生歧义，所以这里换一个名字，把"文本相同"这个巧合从测试里挪走。
  { name: 'readme.txt', path: '/w/q3/readme.txt', isDirectory: false, noisy: false },
];

const MEMO: AgentsMemoView = { exists: true, content: '报告一律用中文。' };

function noop() {}

function renderPage(overrides: Record<string, unknown> = {}) {
  return render(
    <ProjectDetailPage
      detail={DETAIL}
      rootEntries={ROOT_ENTRIES}
      childrenOf={{}}
      memo={MEMO}
      onBack={noop}
      onExpand={noop}
      onRefreshTree={noop}
      onOpenTask={noop}
      onOpenFolder={noop}
      onNewTaskHere={noop}
      onSaveMemo={async () => ({ ok: true })}
      onOpenAutomation={noop}
      {...overrides}
    />,
  );
}

describe('ProjectDetailPage', () => {
  it('中栏同时有任务与文件两个分区', () => {
    renderPage();
    expect(screen.getByText(/任务 \(1\)/)).toBeTruthy();
    // 用 role 精确定位「文件」分区头的折叠按钮，而不是裸文本 ——
    // 主区「最近的文件动作」表格的列头恰好也叫「文件」，裸文本查找会两处都命中
    expect(screen.getByRole('button', { name: '文件' })).toBeTruthy();
    expect(screen.getByText('写周报')).toBeTruthy();
  });

  it('噪声目录仍然列出来 —— 隐藏会让人以为生成的文件丢了', () => {
    renderPage();
    // 不止是"有文字出现"：还要落在真正的树节点上，且标记为弱化而不是被过滤掉。
    // 如果实现把 noisy 目录整行从列表里去掉，getByText 会直接抛错；
    // 如果实现"渲染了但没走 muted 弱化路径"，下面的 data-muted 断言会失败 ——
    // 两种偷懒方式都会被拦住。
    const label = screen.getByText('node_modules');
    const item = label.closest('.ew-tree-item');
    expect(item).not.toBeNull();
    expect(item?.getAttribute('data-muted')).toBe('true');
    // 且不是靠 aria-hidden / display:none 之类"仍在 DOM 但对用户不可见"的手法蒙混
    expect(item?.closest('[aria-hidden="true"]')).toBeNull();

    // 非噪声目录不应该被打上同样的标记，否则 muted 就成了摆设
    const srcItem = screen.getByText('src').closest('.ew-tree-item');
    expect(srcItem?.getAttribute('data-muted')).not.toBe('true');
  });

  it('点目录才去读那一层 —— 懒加载，不递归扫全盘', () => {
    const onExpand = vi.fn();
    renderPage({
      onExpand,
      childrenOf: {
        '/w/q3/src': [
          { name: 'nested', path: '/w/q3/src/nested', isDirectory: true, noisy: false },
        ],
      },
    });

    fireEvent.click(screen.getByText('src'));
    // 展开哪层读哪层：只对被点的那个目录发起一次请求
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledWith('/w/q3/src');

    // 子目录露出来之后再点它，读的是"那一层"（子目录自己的路径），
    // 而不是又把父目录的路径读了一遍 —— 证明懒加载没有偷偷变成递归预取。
    fireEvent.click(screen.getByText('nested'));
    expect(onExpand).toHaveBeenCalledTimes(2);
    expect(onExpand).toHaveBeenLastCalledWith('/w/q3/src/nested');

    // 收起再点开同一层，理应重新触发一次读取（树不接 fs watch，可能已经旧了），
    // 但收起本身不应该额外触发 onExpand
    fireEvent.click(screen.getByText('src')); // 收起
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  it('点文件不触发展开', () => {
    const onExpand = vi.fn();
    renderPage({ onExpand });
    fireEvent.click(screen.getByText('readme.txt'));
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('文件分区头有刷新按钮 —— 不接 fs 监听，就不能假装是实时的', () => {
    const onRefreshTree = vi.fn();
    renderPage({ onRefreshTree });
    fireEvent.click(screen.getByLabelText('刷新文件树'));
    expect(onRefreshTree).toHaveBeenCalled();
  });

  it('主区把最近的文件动作与绑定的自动化都列出来', () => {
    renderPage();
    expect(screen.getByText('report.docx')).toBeTruthy();
    expect(screen.getByText('每周一汇总')).toBeTruthy();
  });

  it('路径失效时出横幅，且「在此空间新建任务」禁用并给原因', () => {
    renderPage({ detail: { ...DETAIL, rootMissing: true } });
    expect(screen.getByText(/路径已失效/)).toBeTruthy();
    const button = screen.getByText('在此空间新建任务').closest('button');
    expect(button?.getAttribute('disabled')).not.toBeNull();
    expect(button?.getAttribute('title')).toBeTruthy();
  });

  it('AGENTS.md 不存在时说"还没有"并仍可创建 —— 与"内容是空的"不是一回事', () => {
    renderPage({ memo: { exists: false, content: '' } });
    expect(screen.getByText(/还没有空间记忆/)).toBeTruthy();
    expect(screen.getByLabelText('空间记忆')).toBeTruthy();
  });

  it('AGENTS.md 存在但内容为空时，不能说成"还没有" —— 那是用户自己清空的', () => {
    // 如果实现只看 content === '' 而忽略 exists，这条会和上一条一样冒出「还没有空间记忆」，
    // 从而暴露"没有真的区分 exists"这个 bug。
    renderPage({ memo: { exists: true, content: '' } });
    expect(screen.queryByText(/还没有空间记忆/)).toBeNull();
    expect(screen.getByLabelText('空间记忆')).toBeTruthy();
  });

  it('保存后给出「已保存」反馈 —— 没有反馈用户会反复点', async () => {
    const onSaveMemo = vi.fn(async () => ({ ok: true }));
    renderPage({ onSaveMemo });
    fireEvent.change(screen.getByLabelText('空间记忆'), { target: { value: '新内容' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
    expect(onSaveMemo).toHaveBeenCalledWith('新内容');
  });

  /*
   * ── C3：被拒的写入不能显示"已保存" ──
   *
   * 以前这里是 `onSaveMemo(draft).then(() => setSaved(true))`——不看 `ok`，
   * 无条件显示已保存。用户写完长期指令、被路径闸门或系统报错拒绝了，
   * 却被告知保存成功，内容其实从没落盘。
   */
  it('写被拒时不显示「已保存」，而是把拒绝理由摆出来', async () => {
    const onSaveMemo = vi.fn(async () => ({ ok: false, refused: '磁盘空间不足，没能保存。' }));
    renderPage({ onSaveMemo });
    fireEvent.change(screen.getByLabelText('空间记忆'), { target: { value: '新内容' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('磁盘空间不足，没能保存。')).toBeTruthy());
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('一个任务都没有时中栏说清是空的，而不是一片留白', () => {
    renderPage({ detail: { ...DETAIL, tasks: [] } });
    expect(screen.getByText(/这个空间还没有任务/)).toBeTruthy();
  });
});
