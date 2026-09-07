/**
 * 项目列表页（02 §4.3）。
 *
 * 这一页最要紧的两条：**移除要说清只解绑不删文件**，
 * **路径失效要一眼看得见且不静默灰掉**。
 *
 * 另外两条不在设计文档原话里，是接线时才会暴露的坑，专门补了测试钉住：
 *   · `recencyLabel` 缺席时不能留下孤零零的分隔符（08 任务卡的数字用数组渲染，
 *     没有分隔符字符串，但仍然验一遍，免得以后有人改成拼接字符串）。
 *   · `⋯` 菜单与 `Dialog` 都能被 Esc 关掉，且能同时打开 —— 对话框打开时
 *     必须顺手关掉还开着的行内菜单，否则对话框关闭后菜单变成背后的孤儿。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectsPage } from '../src/renderer/views/projects.js';
import type { ProjectCardView } from '../src/shared/ipc.js';

const OK: ProjectCardView = {
  id: 'p1',
  name: '季度汇报',
  rootDisplay: '~/w/q3',
  rootMissing: false,
  taskCount: 12,
  artifactCount: 5,
  recencyLabel: '2 小时前',
};

const BROKEN: ProjectCardView = {
  id: 'p2',
  name: '旧方案',
  rootDisplay: '~/Desktop/old',
  rootMissing: true,
  taskCount: 3,
  artifactCount: 0,
};

function noop() {}

function renderPage(projects: readonly ProjectCardView[], overrides: Record<string, unknown> = {}) {
  return render(
    <ProjectsPage
      projects={projects}
      onCreate={noop}
      onImport={noop}
      onRename={noop}
      onRemove={noop}
      onOpenFolder={noop}
      onNewTaskIn={noop}
      onOpenDetail={noop}
      onPickDirectory={async () => undefined}
      {...overrides}
    />,
  );
}

describe('ProjectsPage', () => {
  it('卡片上有三个数字与路径', () => {
    renderPage([OK]);
    expect(screen.getByText('季度汇报')).toBeTruthy();
    expect(screen.getByText('~/w/q3')).toBeTruthy();
    expect(screen.getByText('12 个任务')).toBeTruthy();
    expect(screen.getByText('5 个产物')).toBeTruthy();
    expect(screen.getByText('2 小时前')).toBeTruthy();
  });

  it('没有任务时不显示"最近活动"那一段 —— 而不是显示"从未"', () => {
    const { container } = renderPage([{ ...OK, recencyLabel: undefined }]);
    expect(screen.queryByText('从未')).toBeNull();
    // 角标行是数组渲染（每个数字一个 span），不是拼字符串，所以缺席时
    // 不该留下孤零零的分隔符 —— 钉住这一点，免得以后有人改成字符串拼接。
    const badges = container.querySelector('.ew-item-card-badges');
    expect(badges?.textContent).not.toContain('·');
    expect(badges?.textContent).not.toMatch(/^\s*·|·\s*$/);
  });

  it('失效卡整卡转 warning，并把失效说在卡上', () => {
    const { container } = renderPage([BROKEN]);
    expect(container.querySelector('[data-tone="warning"]')).toBeTruthy();
    expect(screen.getByText(/路径已失效/)).toBeTruthy();
  });

  it('失效空间的「在此空间新建任务」禁用**并给原因** —— 不静默灰掉', () => {
    renderPage([BROKEN]);
    fireEvent.click(screen.getByLabelText('旧方案 的更多操作'));
    const item = screen.getByText('在此空间新建任务').closest('button');
    expect(item?.getAttribute('disabled')).not.toBeNull();
    expect(item?.getAttribute('title')).toContain('路径');
  });

  it('移除的确认文案必须说清不删文件 —— 说反了用户丢文件', () => {
    renderPage([OK]);
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('从列表移除'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('不会删除');
    expect(dialog.textContent).toContain('磁盘');
    /*
     * 强调必须是真的加粗，不能是 markdown 的星号。
     *
     * JSX 里 `**不会删除**` 会**原样渲染成星号** —— textContent 里照样含「不会删除」，
     * 所以上面两条断言对此完全无感。而这是整个功能里最要紧的一句话
     * （「移除」很容易被读成「删除」），它带着两串星号出厂只会让人怀疑这句话本身。
     */
    expect(dialog.textContent).not.toContain('*');
    expect(dialog.querySelector('strong')?.textContent).toBe('不会删除');
  });

  it('确认后才真的调 onRemove', () => {
    const onRemove = vi.fn();
    renderPage([OK], { onRemove });
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('从列表移除'));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('移除'));
    expect(onRemove).toHaveBeenCalledWith('p1');
  });

  it('空态说清"还没有空间"并直接给两个动作 —— 不是一句"暂无数据"', () => {
    renderPage([]);
    expect(screen.getByText(/还没有工作空间/)).toBeTruthy();
    expect(screen.getAllByText('新建空间').length).toBeGreaterThan(0);
    expect(screen.getAllByText('导入现有文件夹').length).toBeGreaterThan(0);
  });

  it('搜索按名称与路径过滤', () => {
    renderPage([OK, BROKEN]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } });
    expect(screen.queryByText('季度汇报')).toBeNull();
    expect(screen.getByText('旧方案')).toBeTruthy();
  });

  it('被拒绝的路径把原话显示出来 —— 而不是一个点了没反应的按钮', () => {
    renderPage([], { refusal: '这个目录被安全策略拦下了（受保护目录），换一个吧。' });
    expect(screen.getByText(/被安全策略拦下了/)).toBeTruthy();
  });

  it('Esc 能关掉单独打开的 ⋯ 菜单', () => {
    renderPage([OK]);
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    expect(screen.getByText('从列表移除')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('从列表移除')).toBeNull();
  });

  it('Esc 能关掉对话框，且对话框依赖的状态（草稿名称）在下次打开前不会被污染', () => {
    renderPage([OK]);
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('改名'));
    const dialog = screen.getByRole('dialog');
    const nameInput = screen.getByLabelText('名称') as HTMLInputElement;
    expect(nameInput.value).toBe('季度汇报');
    fireEvent.change(nameInput, { target: { value: '改到一半' } });
    // Esc 关闭对话框：直接在对话框节点上触发，因为 Dialog 的 Esc 处理
    // 是挂在自己这层的 onKeyDown（冒泡到它才会触发），不是 document 监听
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // 重新打开改名对话框：草稿应该是项目的当前名字，而不是上次没保存就关掉的半截输入
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('改名'));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('季度汇报');
  });

  it('打开某张卡的 ⋯ 菜单后，从标题栏新建空间会顺手关掉它 —— 不留孤儿菜单', () => {
    renderPage([OK, BROKEN]);
    // 打开季度汇报卡的菜单
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    expect(screen.getByText('从列表移除')).toBeTruthy();
    // 不经过菜单，直接从标题栏打开「新建空间」对话框
    fireEvent.click(screen.getAllByText('新建空间')[0]!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 菜单必须已经被关掉，而不是被对话框盖住却还开着
    expect(screen.queryByText('从列表移除')).toBeNull();
    // 取消对话框后，菜单也不应该"重新出现"（证明它是真关了，不是被 z-index 挡住）
    fireEvent.click(screen.getByText('取消'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('从列表移除')).toBeNull();
  });
});
