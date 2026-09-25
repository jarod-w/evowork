import { describe, expect, it } from 'vitest';

import {
  AUTO_REVIEW_UNAVAILABLE_REASON,
  BUILTIN_SCENARIOS,
  composerModeAvailability,
  composeInstructions,
  expandTurnStart,
  MODES,
  resolveModeId,
  type Scenario,
} from '../src/scenario.js';

const OFFICE = BUILTIN_SCENARIOS.find((s) => s.id === 'office') as Scenario;

const FRAGMENTS: Record<string, string> = {
  'modes/craft.md': '你可以动手：读写工作空间内的文件、执行命令。',
  'modes/ask.md': '只回答与解释，不要修改任何文件，也不要联网。',
  'modes/plan.md': '先给出计划，等用户确认后再执行。',
  'modes/craft-office.md': '这是办公场景：产物优先用 docx / xlsx / pptx。',
};

const read = (file: string): string | undefined => FRAGMENTS[file];

const base = {
  threadId: 't1',
  input: [] as const,
  scenario: OFFICE,
  readInstructions: read,
};

describe('展开优先级：场景默认值 → 审批档 → 用户显式选择（03 §2.4）', () => {
  it('用户覆盖胜出', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [{ type: 'text', text: '生成周报' }],
      scenario: { ...OFFICE, model: 'deepseek-v4-flash' },
      overrides: { model: 'glm-5.3-flash' },
      readInstructions: read,
    });
    expect(result.params.collaborationMode?.settings?.model).toBe('glm-5.3-flash');
  });

  it('Q45 三档都映射到内核的 `default`，不新增 ModeKind（D8 / F2）', () => {
    for (const modeId of ['request-approval', 'approve-for-me', 'full-access'] as const) {
      expect(
        expandTurnStart({ ...base, overrides: { modeId } }).params.collaborationMode?.mode,
      ).toBe('default');
    }
    expect(MODES['request-approval'].kernelMode).toBe('default');
    expect(MODES['approve-for-me'].kernelMode).toBe('default');
    expect(MODES['full-access'].kernelMode).toBe('default');
  });

  it('请求批准 → evowork-workspace + on-request + user', () => {
    const result = expandTurnStart({ ...base, overrides: { modeId: 'request-approval' } });
    // 内核 AskForApproval 是 kebab-case。onRequest 会让 thread/start 回 -32600。
    expect(result.params.permissions).toBe('evowork-workspace');
    expect(result.params.approvalPolicy).toBe('on-request');
    expect(result.params.approvalsReviewer).toBe('user');
    expect(result.origin.modeId).toBe('request-approval');
    expect(result.origin.permissionId).toBe('evowork-workspace');
  });

  it('帮我批准 → 同样的权限与策略，但 reviewer=auto_review', () => {
    const result = expandTurnStart({ ...base, overrides: { modeId: 'approve-for-me' } });
    expect(result.params.permissions).toBe('evowork-workspace');
    expect(result.params.approvalPolicy).toBe('on-request');
    expect(result.params.approvalsReviewer).toBe('auto_review');
  });

  it('完全访问下发内置档，投影表仍记 evowork-full', () => {
    const result = expandTurnStart({ ...base, overrides: { modeId: 'full-access' } });
    // 命名档不能 extends :danger-full-access，发出去就是 -32600。
    expect(result.params.permissions).toBe(':danger-full-access');
    expect(result.params.approvalPolicy).toBe('never');
    expect(result.params.approvalsReviewer).toBe('user');
    expect(result.origin.permissionId).toBe('evowork-full');
  });

  it('权限由审批档决定，用户另传的 permissions 不能把完全访问偷运进来', () => {
    const result = expandTurnStart({
      ...base,
      overrides: { modeId: 'request-approval', permissions: 'evowork-full' },
    });
    expect(result.params.permissions).toBe('evowork-workspace');
  });

  it('**不与 sandboxPolicy 同传**（F5：两者互斥）', () => {
    const result = expandTurnStart(base);
    expect(result.params.permissions).toBeDefined();
    expect('sandboxPolicy' in result.params).toBe(false);
    expect('sandbox' in result.params).toBe(false);
  });

  it('缺省档是请求批准', () => {
    expect(expandTurnStart(base).origin.modeId).toBe('request-approval');
    expect(OFFICE.mode).toBe('request-approval');
  });
});

describe('帮我批准不可用时禁止发出去（Q45）', () => {
  it('reviewer 不可用 → 抛出「安全自动审查还没接通」，不改成 user', () => {
    expect(() =>
      expandTurnStart({
        ...base,
        overrides: { modeId: 'approve-for-me' },
        approvalsReviewerAvailable: false,
      }),
    ).toThrow(AUTO_REVIEW_UNAVAILABLE_REASON);
  });

  it('reviewer 不可用时，请求批准仍然能发，且 reviewer 是 user', () => {
    const result = expandTurnStart({
      ...base,
      overrides: { modeId: 'request-approval' },
      approvalsReviewerAvailable: false,
    });
    expect(result.params.approvalsReviewer).toBe('user');
  });

  it('Composer 菜单把帮我批准标成禁用并给出原因，不隐藏', () => {
    const options = composerModeAvailability({ approvalsReviewerAvailable: false });
    expect(options.map((o) => o.id)).toEqual(['request-approval', 'approve-for-me', 'full-access']);
    const approve = options.find((o) => o.id === 'approve-for-me');
    expect(approve?.allowed).toBe(false);
    expect(approve?.disabledReason).toBe(AUTO_REVIEW_UNAVAILABLE_REASON);
  });
});

describe('developer_instructions 拼接（03 §2.4）', () => {
  it('**模式片段在前、场景片段在后**（场景更具体，后写的优先）', () => {
    const text = composeInstructions(base, MODES['request-approval']);
    const modeIdx = text?.indexOf('你可以动手') ?? -1;
    const scenarioIdx = text?.indexOf('这是办公场景') ?? -1;
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(scenarioIdx).toBeGreaterThan(modeIdx);
  });

  it('末尾附运行时上下文（日期 / 工作空间 / 可用技能）', () => {
    const text = composeInstructions(
      {
        ...base,
        runtime: {
          today: '2026-09-05',
          workspacePath: '/Users/x/work/weekly',
          availableSkills: ['presentations', 'spreadsheets'],
        },
      },
      MODES['request-approval'],
    );
    expect(text).toContain('2026-09-05');
    expect(text).toContain('/Users/x/work/weekly');
    expect(text).toContain('presentations');
    expect((text ?? '').lastIndexOf('2026-09-05')).toBeGreaterThan(
      (text ?? '').indexOf('这是办公场景'),
    );
  });

  it('片段文件缺失时不报错（config 可能没装全），只是指令更短', () => {
    const text = composeInstructions(
      { threadId: 't1', input: [], scenario: OFFICE, readInstructions: () => undefined },
      MODES['request-approval'],
    );
    expect(text).toBeUndefined();
  });

  it('三档共用 craft.md，ask.md 不进 Composer 主路径', () => {
    for (const modeId of ['request-approval', 'approve-for-me', 'full-access'] as const) {
      const result = expandTurnStart({ ...base, overrides: { modeId } });
      expect(result.params.collaborationMode?.settings?.developer_instructions).toContain(
        '你可以动手',
      );
      expect(result.params.collaborationMode?.settings?.developer_instructions).not.toContain(
        '不要修改任何文件',
      );
      expect(MODES[modeId].instructionsFile).toBe('modes/craft.md');
    }
  });
});

/**
 * F22：`Settings` 是 v2 里唯一没有 `rename_all` 的结构体，线上字段名就是 snake_case，
 * 而它也不 `deny_unknown_fields` —— 写成 camelCase 的后果**不是报错，是被静默丢掉**。
 *
 * 丢掉的那段指令是怎么干活。产品名是另一层：`thread/start.baseInstructions`
 * （F25）。写错时两层都丢，用户问「介绍一下你自己」会得到 Codex CLI（K5）。
 */
describe('F22：settings 的字段名是 snake_case', () => {
  it('三个字段一律 snake_case，且不留一份 camelCase 的影子', () => {
    const settings = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, model: 'evowork/deepseek-v4-flash', reasoningEffort: 'medium' },
      readInstructions: read,
    }).params.collaborationMode?.settings as Record<string, unknown>;

    expect(Object.keys(settings).sort()).toEqual([
      'developer_instructions',
      'model',
      'reasoning_effort',
    ]);
  });
});

describe('降级（09 §3.3）—— 必须显式，且带上"还必须做什么"', () => {
  it('collaborationMode 不可用 → 退回 model + effort，审批字段仍在', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, model: 'deepseek-v4-flash', reasoningEffort: 'medium' },
      overrides: { modeId: 'request-approval' },
      readInstructions: read,
      collaborationModeAvailable: false,
    });

    expect(result.params.collaborationMode).toBeUndefined();
    expect(result.params.model).toBe('deepseek-v4-flash');
    expect(result.params.effort).toBe('medium');
    expect(result.params.approvalPolicy).toBe('on-request');
    expect(result.params.approvalsReviewer).toBe('user');
    expect(result.degradations[0]).toContain('审批三档');
  });

  it('可用时**不同时**传顶层 model —— 免得"到底哪个生效"要去读内核代码', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, model: 'deepseek-v4-flash' },
      readInstructions: read,
      collaborationModeAvailable: true,
    });
    expect(result.params.collaborationMode?.settings?.model).toBe('deepseek-v4-flash');
    expect(result.params.model).toBeUndefined();
  });

  it('permissions 字段不可用 → 仍下发审批字段，且不含 sandboxPolicy', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: OFFICE,
      readInstructions: read,
      permissionsFieldAvailable: false,
    });
    expect(result.params.permissions).toBeUndefined();
    expect(result.params.approvalPolicy).toBe('on-request');
    expect(result.params.approvalsReviewer).toBe('user');
    expect('sandboxPolicy' in result.params).toBe(false);
    expect(result.degradations.some((d) => d.includes('企业自定义权限档'))).toBe(true);
  });
});

describe('场景包（03 §2.2）', () => {
  it('三个 v1 场景与截图一致，且 office 是默认', () => {
    expect(BUILTIN_SCENARIOS.map((s) => s.id)).toEqual(['office', 'code', 'design']);
    expect(BUILTIN_SCENARIOS.filter((s) => s.default)).toHaveLength(1);
    expect(OFFICE.default).toBe(true);
    expect(BUILTIN_SCENARIOS.every((scenario) => scenario.model === undefined)).toBe(true);
  });

  it('office 的 5 个 chips 与截图一致，且 chip 只写入 Composer 不发送（prompt 以冒号结尾）', () => {
    expect(OFFICE.chips).toHaveLength(5);
    expect(OFFICE.chips?.map((c) => c.label)).toEqual([
      '文档处理',
      '金融服务',
      '数据分析及可视化',
      '个人工作台',
      '幻灯片',
    ]);
    expect(OFFICE.chips?.[0]?.requiresFile).toBe(true);
  });

  it('office 场景启用四个办公技能（08 §5.2）', () => {
    expect(OFFICE.skills).toEqual(['documents', 'spreadsheets', 'presentations', 'charts']);
  });

  it('design 场景带上界面设计技能，不把它算进办公四件套', () => {
    const design = BUILTIN_SCENARIOS.find((s) => s.id === 'design');
    expect(design?.skills).toEqual(['charts', 'ui-design']);
    expect(design?.chips?.map((c) => c.label)).toEqual(['出几个方案', '配图', '设计界面']);
  });

  it('三档文案与 10 §2.4 逐字一致', () => {
    expect(MODES['request-approval'].label).toBe('请求批准');
    expect(MODES['request-approval'].summary).toBe('编辑工作空间外的文件或使用互联网时询问你');
    expect(MODES['approve-for-me'].label).toBe('帮我批准');
    expect(MODES['approve-for-me'].summary).toBe('仅对检测到的风险操作请求批准');
    expect(MODES['full-access'].label).toBe('完全访问');
    expect(MODES['full-access'].summary).toBe('可以读写这台电脑上的文件并联网');
    expect(MODES['full-access'].summary).not.toContain('任何文件');
  });

  it('origin 带出投影表需要的 EvoWork 字段', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, budgetLimit: 200_000 },
      overrides: { modeId: 'full-access' },
      readInstructions: read,
    });
    expect(result.origin).toEqual({
      scenarioId: 'office',
      modeId: 'full-access',
      permissionId: 'evowork-full',
      budgetLimit: 200_000,
    });
  });

  it('旧的 craft / plan / ask 任务行收成请求批准，不把帮我批准降级', () => {
    expect(resolveModeId('craft')).toBe('request-approval');
    expect(resolveModeId('plan')).toBe('request-approval');
    expect(resolveModeId('ask')).toBe('request-approval');
    expect(resolveModeId('approve-for-me')).toBe('approve-for-me');
  });
});
