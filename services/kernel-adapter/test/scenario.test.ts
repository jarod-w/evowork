import { describe, expect, it } from 'vitest';

import {
  BUILTIN_SCENARIOS,
  composeInstructions,
  expandTurnStart,
  MODES,
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

describe('展开优先级：场景默认值 → 工作模式 → 用户显式选择（03 §2.4）', () => {
  it('用户覆盖胜出', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [{ type: 'text', text: '生成周报' }],
      scenario: { ...OFFICE, model: 'deepseek-chat' },
      overrides: { model: 'glm-5.3-flash' },
      readInstructions: read,
    });
    expect(result.params.collaborationMode?.settings?.model).toBe('glm-5.3-flash');
  });

  it('craft / ask 都映射到内核的 `default`，plan 映射到 `plan`（F2：只有两个枚举值）', () => {
    const base = {
      threadId: 't1',
      input: [] as const,
      scenario: OFFICE,
      readInstructions: read,
    };
    expect(
      expandTurnStart({ ...base, overrides: { modeId: 'craft' } }).params.collaborationMode?.mode,
    ).toBe('default');
    expect(
      expandTurnStart({ ...base, overrides: { modeId: 'ask' } }).params.collaborationMode?.mode,
    ).toBe('default');
    expect(
      expandTurnStart({ ...base, overrides: { modeId: 'plan' } }).params.collaborationMode?.mode,
    ).toBe('plan');
  });

  it('**Ask 模式固定只读**：用户选的权限被忽略（03 §4.5 的模式联动）', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: OFFICE,
      overrides: { modeId: 'ask', permissions: 'evowork-full' },
      readInstructions: read,
    });
    expect(result.params.permissions).toBe('evowork-ask');
    expect(result.origin.permissionId).toBe('evowork-ask');
  });

  it('非 Ask 模式尊重用户的权限选择', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: OFFICE,
      overrides: { modeId: 'craft', permissions: 'evowork-full' },
      readInstructions: read,
    });
    expect(result.params.permissions).toBe('evowork-full');
  });

  it('**不与 sandboxPolicy 同传**（F5：两者互斥）', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: OFFICE,
      readInstructions: read,
    });
    expect(result.params.permissions).toBeDefined();
    expect('sandboxPolicy' in result.params).toBe(false);
    expect('sandbox' in result.params).toBe(false);
  });
});

describe('developer_instructions 拼接（03 §2.4）', () => {
  it('**模式片段在前、场景片段在后**（场景更具体，后写的优先）', () => {
    const text = composeInstructions(
      {
        threadId: 't1',
        input: [],
        scenario: OFFICE,
        readInstructions: read,
      },
      MODES.craft,
    );
    const modeIdx = text?.indexOf('你可以动手') ?? -1;
    const scenarioIdx = text?.indexOf('这是办公场景') ?? -1;
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(scenarioIdx).toBeGreaterThan(modeIdx);
  });

  it('末尾附运行时上下文（日期 / 工作空间 / 可用技能）', () => {
    const text = composeInstructions(
      {
        threadId: 't1',
        input: [],
        scenario: OFFICE,
        readInstructions: read,
        runtime: {
          today: '2026-09-05',
          workspacePath: '/Users/x/work/weekly',
          availableSkills: ['presentations', 'spreadsheets'],
        },
      },
      MODES.craft,
    );
    expect(text).toContain('2026-09-05');
    expect(text).toContain('/Users/x/work/weekly');
    expect(text).toContain('presentations');
    // 运行时上下文在最后
    expect((text ?? '').lastIndexOf('2026-09-05')).toBeGreaterThan(
      (text ?? '').indexOf('这是办公场景'),
    );
  });

  it('片段文件缺失时不报错（config 可能没装全），只是指令更短', () => {
    const text = composeInstructions(
      { threadId: 't1', input: [], scenario: OFFICE, readInstructions: () => undefined },
      MODES.ask,
    );
    expect(text).toBeUndefined();
  });

  it('Ask 模式的指令来自 config/modes/ask.md —— **不需要内核补丁**（F1，P3 已删）', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: OFFICE,
      overrides: { modeId: 'ask' },
      readInstructions: read,
    });
    expect(result.params.collaborationMode?.settings?.developerInstructions).toContain(
      '不要修改任何文件',
    );
    expect(MODES.ask.instructionsFile).toBe('modes/ask.md');
  });
});

describe('降级（09 §3.3）—— 必须显式，且带上"还必须做什么"', () => {
  it('collaborationMode 不可用 → 退回 model + effort，并报出 D8 的硬要求', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, model: 'deepseek-chat', reasoningEffort: 'medium' },
      overrides: { modeId: 'ask' },
      readInstructions: read,
      collaborationModeAvailable: false,
    });

    expect(result.params.collaborationMode).toBeUndefined();
    expect(result.params.model).toBe('deepseek-chat');
    expect(result.params.effort).toBe('medium');
    expect(result.degradations[0]).toContain('ToolContributor');
  });

  it('可用时**不同时**传顶层 model —— 免得"到底哪个生效"要去读内核代码', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, model: 'deepseek-chat' },
      readInstructions: read,
      collaborationModeAvailable: true,
    });
    expect(result.params.collaborationMode?.settings?.model).toBe('deepseek-chat');
    expect(result.params.model).toBeUndefined();
  });

  it('permissions 字段不可用 → 退回审批策略并显式报降级', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: OFFICE,
      readInstructions: read,
      permissionsFieldAvailable: false,
    });
    expect(result.params.permissions).toBeUndefined();
    expect(result.params.approvalPolicy).toBe('onRequest');
    expect(result.degradations.some((d) => d.includes('企业自定义权限档'))).toBe(true);
  });
});

describe('场景包（03 §2.2）', () => {
  it('三个 v1 场景与截图一致，且 office 是默认', () => {
    expect(BUILTIN_SCENARIOS.map((s) => s.id)).toEqual(['office', 'code', 'design']);
    expect(BUILTIN_SCENARIOS.filter((s) => s.default)).toHaveLength(1);
    expect(OFFICE.default).toBe(true);
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
    // 「文档处理」需要文件（03 §3.2：同时打开文件选择器）
    expect(OFFICE.chips?.[0]?.requiresFile).toBe(true);
  });

  it('office 场景启用四个办公技能（08 §5.2）', () => {
    expect(OFFICE.skills).toEqual(['documents', 'spreadsheets', 'presentations', 'charts']);
  });

  it('三个模式的权限 profile 与 10 §2.2 的目录一致', () => {
    expect(MODES.craft.permissions).toBe('evowork-workspace');
    expect(MODES.plan.permissions).toBe('evowork-plan');
    expect(MODES.ask.permissions).toBe('evowork-ask');
    expect(MODES.ask.lockPermissions).toBe(true);
  });

  it('origin 带出投影表需要的 EvoWork 字段', () => {
    const result = expandTurnStart({
      threadId: 't1',
      input: [],
      scenario: { ...OFFICE, budgetLimit: 200_000 },
      overrides: { modeId: 'plan' },
      readInstructions: read,
    });
    expect(result.origin).toEqual({
      scenarioId: 'office',
      modeId: 'plan',
      permissionId: 'evowork-workspace',
      budgetLimit: 200_000,
    });
  });
});
