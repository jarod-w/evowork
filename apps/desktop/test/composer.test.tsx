/**
 * Composer（03 §4）。
 *
 * 这组测试盯的是**做错了会让用户丢东西或被骗**的地方，不是"输入框能不能打字"：
 * `/` 的行首约束、解析中禁止发送、本机解析承诺的文案、Ask 模式与权限的联动、
 * 被企业策略锁定的档位不能隐藏、完全访问的二次确认、模型不可用时不静默降级。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Composer,
  COMPOSER_PLACEHOLDER,
  DANGER_PROFILE,
  LOCAL_PARSE_PROMISE,
  READ_ONLY_PROFILE,
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
    fireEvent.click(screen.getByRole('menuitem', { name: /Q3.xlsx/ }));
    expect(onChange).toHaveBeenLastCalledWith('@Q3.xlsx ');
  });

  it('**本地指令与技能在菜单里可区分**，且本地指令不进输入框', () => {
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

    fireEvent.click(screen.getByRole('menuitem', { name: /清空/ }));
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

  it('parsingCount 只数解析中的', () => {
    expect(
      parsingCount([parsing, { ...parsing, id: 'a2', state: 'ready' }, { ...parsing, id: 'a3' }]),
    ).toBe(2);
  });
});

describe('底栏三个选择器（03 §4.5）', () => {
  const permissions = [
    { id: ':workspace', label: '默认可写', allowed: true },
    { id: READ_ONLY_PROFILE, label: '只读', allowed: true },
    { id: DANGER_PROFILE, label: '完全访问', allowed: true },
    {
      id: 'enterprise-locked',
      label: '企业档',
      allowed: false,
      disabledReason: '已被企业策略锁定',
    },
  ];

  it('**`allowed:false` 的档位渲染为禁用并显示原因，不隐藏**（F4 / 10 §2）', () => {
    renderComposer({ permissions, permissionId: ':workspace' });
    fireEvent.click(screen.getByRole('button', { name: '权限' }));

    const locked = screen.getByRole('menuitem', { name: /企业档/ });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(locked.textContent).toContain('已被企业策略锁定');
  });

  it('**选完全访问要过二次确认**，且说清只对当前任务生效', () => {
    const onPermissionChange = vi.fn();
    renderComposer({ permissions, permissionId: ':workspace', onPermissionChange });
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }));

    // 还没生效
    expect(onPermissionChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: '确认使用完全访问' });
    expect(dialog.textContent).toContain('仅对当前任务生效');
    expect(dialog.textContent).toContain('可读写这台电脑上的任意文件');

    fireEvent.click(screen.getByRole('button', { name: '我明白，仍然使用' }));
    expect(onPermissionChange).toHaveBeenCalledWith(DANGER_PROFILE);
  });

  it('取消二次确认就什么都不变', () => {
    const onPermissionChange = vi.fn();
    renderComposer({ permissions, permissionId: ':workspace', onPermissionChange });
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onPermissionChange).not.toHaveBeenCalled();
  });

  it('**Ask 模式把权限锁成只读**并给出原因', () => {
    const onPermissionChange = vi.fn();
    renderComposer({ permissions, permissionId: ':workspace', mode: 'ask', onPermissionChange });
    expect(onPermissionChange).toHaveBeenCalledWith(READ_ONLY_PROFILE);

    const trigger = screen.getByRole('button', { name: '权限' });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute('title')).toBe('Ask 模式固定为只读');
  });

  it('切回 Craft **恢复用户上一次的选择**，而不是回落到默认值', () => {
    const onPermissionChange = vi.fn();
    const { rerender } = render(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        permissions={permissions}
        permissionId=":workspace"
        mode="craft"
        onPermissionChange={onPermissionChange}
      />,
    );
    // 进 Ask：记住 :workspace，锁成只读
    rerender(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        permissions={permissions}
        permissionId=":workspace"
        mode="ask"
        onPermissionChange={onPermissionChange}
      />,
    );
    expect(onPermissionChange).toHaveBeenLastCalledWith(READ_ONLY_PROFILE);

    // 切回 Craft：恢复 :workspace
    rerender(
      <Composer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        permissions={permissions}
        permissionId={READ_ONLY_PROFILE}
        mode="craft"
        onPermissionChange={onPermissionChange}
      />,
    );
    expect(onPermissionChange).toHaveBeenLastCalledWith(':workspace');
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
  it('两个入口都在占位里说了', () => {
    renderComposer();
    // 用属性值比对而不是 getByPlaceholderText：后者会把连续空格归一化，
    // 而这里的两段之间**刻意**是两个空格（截图如此）
    expect(screen.getByLabelText('需求输入').getAttribute('placeholder')).toBe(
      COMPOSER_PLACEHOLDER,
    );
    expect(COMPOSER_PLACEHOLDER).toContain('@ 引用');
    expect(COMPOSER_PLACEHOLDER).toContain('/ 调用技能');
  });
});
