/**
 * Composer（03 §4）。
 *
 * 这组测试盯的是**做错了会让用户丢东西或被骗**的地方，不是"输入框能不能打字"：
 * `/` 的行首约束、解析中禁止发送、本机解析承诺的文案、Q45 审批三档、
 * 未接通的权限选择器不得出现、模型不可用时不静默降级。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_REVIEW_UNAVAILABLE_REASON,
  Composer,
  COMPOSER_PLACEHOLDER,
  FULL_ACCESS_CONFIRM,
  LOCAL_PARSE_PROMISE,
  composerModeOptions,
  detectTrigger,
  parsingCount,
  type ComposerProps,
} from '../src/renderer/components/composer.js';

type Over = Partial<ComposerProps>;

/** 受控包装：Composer 是受控组件，测输入行为必须有个真的 state 在外面。 */
function Harness({ over, onSend }: { over?: Over | undefined; onSend?: (() => void) | undefined }) {
  const [value, setValue] = useState(over?.value ?? '');
  return (
    <Composer
      {...over}
      value={value}
      onChange={(next) => {
        setValue(next);
        over?.onChange?.(next);
      }}
      onSend={onSend ?? (() => {})}
    />
  );
}

function renderComposer(over: Over = {}, onSend?: () => void) {
  return render(<Harness over={over} onSend={onSend} />);
}

function type(text: string) {
  const box = screen.getByLabelText('需求输入');
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  return box;
}

describe('触发补全（03 §4.2 / §4.3）', () => {
  it('`@` 在任意位置都触发', () => {
    expect(detectTrigger('看一下 @Q3', 9)?.kind).toBe('@');
    expect(detectTrigger('@', 1)).toEqual({ kind: '@', start: 0, query: '' });
  });

  it('`$` 显式触发技能', () => {
    expect(detectTrigger('请用 $pres', 8)).toEqual({ kind: '$', start: 3, query: 'pres' });
  });

  it('**`/` 只在行首触发** —— 否则 `~/work/a.md` 里的斜杠会弹菜单', () => {
    expect(detectTrigger('/ppt', 4)?.kind).toBe('/');
    expect(detectTrigger('读一下\n/表格', 7)?.kind).toBe('/');
    expect(detectTrigger('~/work/a.md', 11)).toBeNull();
    expect(detectTrigger('见 /tmp/x', 9)).toBeNull();
  });

  it('空格与换行会终止触发（打完一个词就不再是补全上下文）', () => {
    expect(detectTrigger('@Q3 报表', 6)).toBeNull();
  });

  it('`@` 候选按类别分组，选中后插入到输入框', () => {
    const onChange = vi.fn();
    renderComposer({
      onChange,
      mentionCandidates: [
        { id: 'f1', label: 'Q3.xlsx', category: 'file', insertAs: 'mention' },
        { id: 's1', label: 'presentations', category: 'skill', insertAs: 'skill' },
      ],
    });
    type('@Q3');
    fireEvent.click(screen.getByRole('option', { name: /Q3.xlsx/ }));
    expect(onChange).toHaveBeenLastCalledWith('@Q3.xlsx ');
  });

  it('补全使用 combobox/listbox 语义，方向键同步读屏高亮项', () => {
    renderComposer({
      mentionCandidates: [
        { id: 'f1', label: 'Q3.xlsx', category: 'file', insertAs: 'mention' },
        { id: 's1', label: 'Q3 skill', category: 'skill', insertAs: 'skill' },
      ],
    });
    const box = type('@Q3');
    const listbox = screen.getByRole('listbox', { name: '引用候选' });
    const options = screen.getAllByRole('option');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(box.getAttribute('aria-controls')).toBe(listbox.id);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
  });

  it('`@` 查询优先展示前缀命中，并保持同分候选原有顺序', () => {
    renderComposer({
      mentionCandidates: [
        { id: 'f1', label: 'my report.xlsx', category: 'file', insertAs: 'mention' },
        { id: 'f2', label: 'report-final.xlsx', category: 'file', insertAs: 'mention' },
        { id: 'f3', label: 'report-old.xlsx', category: 'file', insertAs: 'mention' },
      ],
    });
    type('@report');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('report-final.xlsx'),
      expect.stringContaining('report-old.xlsx'),
      expect.stringContaining('my report.xlsx'),
    ]);
  });

  it('从 `@` 统一发现中选技能时改写为 `$技能`，并保留结构化引用', () => {
    const onChange = vi.fn();
    const onInsertReference = vi.fn();
    renderComposer({
      onChange,
      onInsertReference,
      mentionCandidates: [
        {
          id: 's1',
          label: '演示文稿',
          name: 'presentations',
          category: 'skill',
          insertAs: 'skill',
        },
      ],
    });
    type('@演示');
    fireEvent.click(screen.getByRole('option', { name: /演示文稿/ }));
    expect(onChange).toHaveBeenLastCalledWith('$演示文稿 ');
    expect(onInsertReference).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'presentations' }),
    );
  });

  it('`$` 菜单只出现技能，选择后插入 `$技能`', () => {
    const onChange = vi.fn();
    renderComposer({
      onChange,
      mentionCandidates: [
        { id: 'f1', label: 'presentations.md', category: 'file', insertAs: 'mention' },
        { id: 's1', label: 'presentations', category: 'skill', insertAs: 'skill' },
      ],
    });
    type('$pres');
    expect(screen.queryByRole('option', { name: /presentations\.md/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /^presentations/ }));
    expect(onChange).toHaveBeenLastCalledWith('$presentations ');
  });

  it('`/` 只展示本地指令，且不进输入框', () => {
    const onRunLocalCommand = vi.fn();
    const onChange = vi.fn();
    renderComposer({
      onChange,
      onRunLocalCommand,
      slashCommands: [
        { id: 'ppt', label: 'ppt', kind: 'skill' },
        { id: 'clear', label: '清空', kind: 'local' },
      ],
    });
    type('/清');
    expect(screen.getByText('本地指令 · 不发送给模型')).toBeTruthy();

    fireEvent.click(screen.getByRole('option', { name: /清空/ }));
    expect(onRunLocalCommand).toHaveBeenCalledWith('clear');
    // 触发文本被清掉，而不是把 `/清空` 当提示词发出去
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});

describe('附件与本机解析（03 §4.4，K6/Q3 的对外表达点）', () => {
  const parsing = {
    id: 'a1',
    name: '年报.pdf',
    kind: 'document' as const,
    sizeLabel: '2.1 MB',
    state: 'parsing' as const,
    progress: 40,
  };

  it('解析中**禁止发送**并说清在本机解析', () => {
    const onSend = vi.fn();
    renderComposer({ attachments: [parsing] }, onSend);
    const send = screen.getByRole('button', { name: '正在本地解析 1 个文件…' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('常驻一行「文件在本机解析，原始文件不上传。」', () => {
    renderComposer({ attachments: [parsing] });
    expect(screen.getByText(LOCAL_PARSE_PROMISE)).toBeTruthy();
    // 这句话必须为真：08 §4 保证没有云端兜底路径。改它之前先改那份文档
    expect(LOCAL_PARSE_PROMISE).toContain('不上传');
  });

  it('解析失败给出「以原始文件引用」这条出路，而不是只报错', () => {
    const onReferAsRaw = vi.fn();
    renderComposer({
      onReferAsRaw,
      attachments: [{ ...parsing, state: 'failed', error: '加密的 PDF' }],
    });
    expect(screen.getByText('解析失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '以原始文件引用' }));
    expect(onReferAsRaw).toHaveBeenCalledWith('a1');
  });

  it('只有失败附件且没有正文时禁止发送，选择原始引用后才可发送', () => {
    const { rerender } = render(
      <Harness over={{ attachments: [{ ...parsing, state: 'failed', error: '读不到内容' }] }} />,
    );
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<Harness over={{ attachments: [{ ...parsing, state: 'ready' }] }} />);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('parsingCount 只数解析中的', () => {
    expect(
      parsingCount([parsing, { ...parsing, id: 'a2', state: 'ready' }, { ...parsing, id: 'a3' }]),
    ).toBe(2);
  });
});

describe('渐进披露的选择器（类 ChatGPT UI §9）', () => {
  const permissions = [
    { id: ':workspace', label: '默认可写', allowed: true },
    { id: ':read-only', label: '只读', allowed: true },
  ];

  it('权限选择器暂不展示 —— 审批三档已经是权限 + 审批的合体（Q45）', () => {
    renderComposer({ permissions, permissionId: ':workspace' });
    expect(screen.queryByRole('button', { name: '权限' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    expect(screen.queryByRole('menuitem', { name: /更多选项/ })).toBeNull();
  });

  it('常显审批档与项目，不再显示 Craft / Plan / Ask', () => {
    renderComposer({ workspaces: [{ id: 'p1', label: '季度汇报' }] });
    expect(screen.getByRole('button', { name: '审批档' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择项目' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '权限' })).toBeNull();
    expect(screen.queryByRole('button', { name: '工作模式' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '审批档' }));
    expect(screen.getByRole('menuitem', { name: /^请求批准/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^帮我批准/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^完全访问/ })).toBeTruthy();
    expect(screen.getByText('编辑工作空间外的文件或使用互联网时询问你')).toBeTruthy();
    expect(screen.getByText('仅对检测到的风险操作请求批准')).toBeTruthy();
    expect(screen.getByText('可以读写这台电脑上的文件并联网')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /^Craft$/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /^Plan$/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /^Ask$/ })).toBeNull();
    expect(screen.queryByText('任何文件')).toBeNull();
  });

  it('已有任务可单独关闭贡献记忆；新任务不显示一个尚无目标 thread 的开关', () => {
    const onMemoryEnabledChange = vi.fn();
    const { unmount } = renderComposer({ memoryEnabled: true, onMemoryEnabledChange });
    const memory = screen.getByRole('button', { name: '任务记忆' });
    expect(memory.textContent).toContain('贡献记忆');
    fireEvent.click(memory);
    fireEvent.click(screen.getByRole('menuitem', { name: /^不贡献记忆/ }));
    expect(onMemoryEnabledChange).toHaveBeenCalledWith(false);

    unmount();
    renderComposer();
    expect(screen.queryByRole('button', { name: '任务记忆' })).toBeNull();
  });
});

describe('审批三档（Q45 / 10 §2.4）', () => {
  it('默认请求批准', () => {
    renderComposer();
    expect(screen.getByRole('button', { name: '审批档' }).textContent).toContain('请求批准');
  });

  it('帮我批准未接通时仍出现在菜单里，禁用并给出原因，点了不会改档', () => {
    const onModeChange = vi.fn();
    renderComposer({
      onModeChange,
      modeOptions: composerModeOptions({ approvalsReviewerAvailable: false }),
    });
    fireEvent.click(screen.getByRole('button', { name: '审批档' }));
    const item = screen.getByRole('menuitem', { name: /帮我批准/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.textContent).toContain(AUTO_REVIEW_UNAVAILABLE_REASON);
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('完全访问未确认时不改档、也不发送', () => {
    const onModeChange = vi.fn();
    const onSend = vi.fn();
    renderComposer({ value: '装个依赖', onModeChange }, onSend);
    fireEvent.click(screen.getByRole('button', { name: '审批档' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }));

    expect(onModeChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: FULL_ACCESS_CONFIRM.title })).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_CONFIRM.writes)).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_CONFIRM.network)).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_CONFIRM.hardBlock)).toBeTruthy();
    expect(screen.queryByText(/电脑上的任何文件/)).toBeNull();

    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onModeChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '审批档' }).textContent).toContain('请求批准');
  });

  it('确认完全访问只对当前任务改档', () => {
    const onModeChange = vi.fn();
    renderComposer({ onModeChange });
    fireEvent.click(screen.getByRole('button', { name: '审批档' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }));
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_CONFIRM.confirmLabel }));
    expect(onModeChange).toHaveBeenCalledWith('full-access');
  });

  it('Windows 停用完全访问时该项可见、禁用，原因来自 platform.ts', () => {
    const reason = '这台机器上的隔离强度还没有评估结论，出于谨慎已暂时停用完全访问';
    renderComposer({
      modeOptions: composerModeOptions({
        fullAccessAllowed: false,
        fullAccessDisabledReason: reason,
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: '审批档' }));
    const item = screen.getByRole('menuitem', { name: /完全访问/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.textContent).toContain(reason);
  });
});

describe('添加内容菜单', () => {
  it('只显示已经接通的入口，并把插件使用与管理分开', () => {
    const onOpenPlugins = vi.fn();
    const onManagePlugins = vi.fn();
    renderComposer({ onOpenPlugins, onManagePlugins });

    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    expect(screen.queryByRole('menuitem', { name: /添加本地文件/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /使用插件/ }));
    expect(onOpenPlugins).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /管理插件/ }));
    expect(onManagePlugins).toHaveBeenCalled();
  });

  it('「使用插件」锚在添加按钮上，选中后只交出提示、不发送', () => {
    const onUsePlugin = vi.fn();
    const onSend = vi.fn();
    renderComposer(
      {
        onOpenPlugins: () => {},
        onManagePlugins: () => {},
        onUsePlugin,
        plugins: [
          {
            id: 'charts',
            kind: 'skill',
            displayName: '图表',
            description: '生成图表（svg / png）。当需要把数据画出来时使用。',
            category: '办公',
            defaultPrompt: '用图表',
          },
        ],
      },
      onSend,
    );

    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /使用插件/ }));

    const dialog = screen.getByRole('dialog', { name: '使用插件' });
    const anchor = screen.getByRole('button', { name: '添加内容' }).parentElement;
    expect(anchor?.contains(dialog)).toBe(true);
    expect(dialog.textContent).toContain('生成图表（svg / png）。当需要把数据画出来时使用。');

    fireEvent.click(screen.getByRole('menuitem', { name: /图表/ }));
    expect(onUsePlugin).toHaveBeenCalledWith(expect.objectContaining({ id: 'charts' }), '用图表');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '使用插件' })).toBeNull();
  });

  it('点「关闭」收起使用插件，不把提示写进输入框', () => {
    const onUsePlugin = vi.fn();
    renderComposer({
      onOpenPlugins: () => {},
      onUsePlugin,
      plugins: [
        {
          id: 'charts',
          kind: 'skill',
          displayName: '图表',
          description: '生成图表',
          category: '办公',
          defaultPrompt: '用图表',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /使用插件/ }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(screen.queryByRole('dialog', { name: '使用插件' })).toBeNull();
    expect(onUsePlugin).not.toHaveBeenCalled();
    expect((screen.getByLabelText('需求输入') as HTMLTextAreaElement).value).toBe('');
  });

  it('点「添加本地文件」调用 onAttach', () => {
    const onAttach = vi.fn();
    renderComposer({ onAttach });
    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /添加本地文件/ }));
    expect(onAttach).toHaveBeenCalled();
  });
});

describe('发送按钮的五个态（03 §4.6）', () => {
  it('空输入禁用', () => {
    renderComposer();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('有内容可发送，⏎ 直接发', () => {
    const onSend = vi.fn();
    renderComposer({}, onSend);
    const box = type('做个周报');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalled();
  });

  it('⇧⏎ 换行不发送', () => {
    const onSend = vi.fn();
    renderComposer({}, onSend);
    const box = type('做个周报');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('执行中变中断', () => {
    const onInterrupt = vi.fn();
    renderComposer({ runState: 'running', onInterrupt });
    fireEvent.click(screen.getByRole('button', { name: '中断' }));
    expect(onInterrupt).toHaveBeenCalled();
  });

  it('超预算变「追加预算继续」（Q11：超预算暂停询问，不是直接失败）', () => {
    const onAddBudget = vi.fn();
    renderComposer({ runState: 'over-budget', onAddBudget });
    fireEvent.click(screen.getByRole('button', { name: '追加预算继续' }));
    expect(onAddBudget).toHaveBeenCalled();
  });

  it('本机并发已满时按钮说清排在第几个（Q11：不阻塞输入）', () => {
    renderComposer({ queuePosition: 1 });
    expect(screen.getByRole('button', { name: '排队中（前面 1 个）' })).toBeTruthy();
  });
});

describe('降级必须显式（03 §8 / D2）', () => {
  it('模型不可用 → danger 条 + 禁用发送，**不换一个模型继续**', () => {
    const onSend = vi.fn();
    renderComposer({ modelUnavailable: { text: '模型网关不可达' }, value: 'x' }, onSend);
    expect(screen.getByRole('alert').textContent).toContain('模型网关不可达');
    const box = screen.getByLabelText('需求输入');
    fireEvent.change(box, { target: { value: '做个周报' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('策略包超期 → 设计原句 + 禁用发送', () => {
    const onSend = vi.fn();
    renderComposer(
      {
        sendLockedReason: '安全策略已过期，已切换为只读模式。请连接企业网络以更新。',
        value: '做个周报',
      },
      onSend,
    );
    expect(screen.getByRole('alert').textContent).toContain('请连接企业网络以更新');
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  /*
   * 模型下拉（01 §5.15）。2026-09-06 截图里"模型列表很乱"的三条成因各守一条：
   * 名字与徽标挤在通用菜单的 180 宽里折行、徽标被压缩、以及分组标题失去层次。
   *
   * 断言落在**类名与结构**上而不是像素上：jsdom 量不出布局，
   * 而这三条修复全部落在 `ew-model-menu` / `ew-model-name` / `ew-model-caps`
   * 这几个选择器上（宽度与滚动在 `LAYOUT.modelMenuMinWidth / modelMenuMaxHeight`）。
   */
  it('模型下拉用自己的菜单类，名字与能力徽标是两列', () => {
    renderComposer({
      models: [
        {
          id: 'evowork/deepseek-v4-flash',
          label: 'deepseek/deepseek-v4-flash',
          provider: 'deepseek',
          capabilities: [
            { id: 'reasoning', label: '推理', available: true },
            { id: 'image-input', label: '读图', available: false },
            { id: 'parallel-tools', label: '并行工具', available: true },
          ],
          credentialSource: 'byok',
        },
      ],
      modelId: 'evowork/deepseek-v4-flash',
    });
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }));

    // 通用 180 宽的 ew-menu 装不下"名字 + 三个徽标"，所以这个下拉必须带自己的类
    expect(document.querySelector('.ew-model-menu')).not.toBeNull();

    const item = screen.getByRole('menuitem', { name: /deepseek-v4-flash/ });
    // 名字单独一列（可省略号），不复用 flex 两行容器的 ew-menu-label
    expect(item.querySelector('.ew-model-name')?.textContent).toBe('deepseek/deepseek-v4-flash');
    // 被省略号截掉时仍能看到完整 id
    expect(item.getAttribute('title')).toBe('deepseek/deepseek-v4-flash');
    // D2：缺失能力划除而不是隐藏 —— 三个徽标一个都不少
    expect(item.querySelectorAll('.ew-model-cap')).toHaveLength(3);
    expect(item.querySelector('.ew-model-cap[data-available="false"]')?.textContent).toBe('读图');
    // 11 §4.2：下拉里看得见凭据来源，用户才不会把托管调用当成自己的密钥
    expect(item.querySelector('.ew-model-source')?.textContent).toBe('自有密钥');
  });

  /*
   * 2026-09-06 用户报的第五个：**点「选择工作空间」后不能正常显示**。
   *
   * 成因不是定位，是"零个选项"：`ew-menu` 带内边距和阴影，一项都没有时它渲染成
   * 一个盖住 Footer 的**白色空盒子**，看起来像界面坏了。这与 01 §5.19
   * 「禁用项必须给出原因」是同一条纪律的另一半 —— **空也要给出原因**。
   */
  it('一个工作空间都没有时，下拉里是一句说明而不是空白浮层', () => {
    renderComposer({ workspaces: [] });
    fireEvent.click(screen.getByRole('button', { name: '选择项目' }));

    const menu = screen.getByRole('menu', { name: '选择项目' });
    // 关键断言：菜单**不是空的**（空盒子就是那个 bug）
    expect(menu.textContent?.trim()).not.toBe('');
    expect(menu.textContent).toContain('还没有项目');
    // 而且说清了后果：不说的话用户只知道选不了，不知道任务会跑在哪
    expect(menu.textContent).toContain('默认目录');
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('有工作空间时列出来，且把路径显示成"任务会跑在哪"', () => {
    const onWorkspaceChange = vi.fn();
    renderComposer({
      workspaces: [{ id: 'p1', label: '周报', description: '/Users/x/work/weekly' }],
      onWorkspaceChange,
    });
    fireEvent.click(screen.getByRole('button', { name: '选择项目' }));
    const item = screen.getByRole('menuitem', { name: /周报/ });
    expect(item.textContent).toContain('/Users/x/work/weekly');
    fireEvent.click(item);
    expect(onWorkspaceChange).toHaveBeenCalledWith('p1');
  });

  it('provider 不支持音频时**隐藏**麦克风，而不是点了报错（03 §4.7）', () => {
    renderComposer({ micAvailable: false });
    expect(screen.queryByRole('button', { name: '语音输入' })).toBeNull();
    renderComposer({ micAvailable: true });
    expect(screen.getByRole('button', { name: '语音输入' })).toBeTruthy();
  });
});

describe('排队与插话（04 §5.4 / §5.5）', () => {
  it('排队区显示数量并可删除', () => {
    const onQueueRemove = vi.fn();
    renderComposer({ queued: [{ id: 'q1', text: '再加一页封面' }], onQueueRemove });
    expect(screen.getByText('排队中 (1)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除排队项：再加一页封面' }));
    expect(onQueueRemove).toHaveBeenCalledWith('q1');
  });

  it('「立即插话」只在执行中出现，且 tooltip 说清它与排队的差别', () => {
    const { rerender } = render(
      <Composer value="" onChange={() => {}} onSend={() => {}} runState="idle" />,
    );
    expect(screen.queryByText('立即插话')).toBeNull();

    rerender(<Composer value="" onChange={() => {}} onSend={() => {}} runState="running" />);
    const label = screen.getByText('立即插话').closest('label');
    expect(label?.getAttribute('title')).toContain('插话会打断当前思路');
    expect(label?.getAttribute('title')).toContain('默认排队');
  });

  it('执行中按 Esc 中断（04 §5.5）', () => {
    const onInterrupt = vi.fn();
    renderComposer({ runState: 'running', onInterrupt });
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Escape' });
    expect(onInterrupt).toHaveBeenCalled();
  });
});

describe('占位文案（03 §4.1）', () => {
  it('保持简短，不在占位文案里堆工具说明', () => {
    renderComposer();
    // 用属性值比对而不是 getByPlaceholderText：后者会把连续空格归一化，
    // 而这里的两段之间**刻意**是两个空格（截图如此）
    expect(screen.getByLabelText('需求输入').getAttribute('placeholder')).toBe(
      COMPOSER_PLACEHOLDER,
    );
    expect(COMPOSER_PLACEHOLDER).toBe('输入需求，或描述你想完成的工作');
  });
});
