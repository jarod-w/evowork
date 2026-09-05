/**
 * 首页（03）。
 *
 * ## 首页不创建 Thread
 *
 * 03 §1 的这条约束比看上去重要：用户发送第一条消息时才 `thread/start` + `turn/start`，
 * 所以**从首页离开不产生空任务**，也就不需要"草稿任务"这个概念，以及随之而来的
 * "什么时候清理草稿""草稿算不算并发"两个问题。这个组件因此没有任何"新建"的副作用 ——
 * 它只把输入攒起来，交给 `onSend`。
 *
 * ## 场景 ≠ 工作模式
 *
 * 03 §2.1：场景回答"我在做哪一类活"，工作模式回答"你能动手到什么程度"，两者正交。
 * 所以场景在 Hero 下面用**深色** SegmentedControl（01 §5.10：决定页面装什么），
 * 而模式在 Composer 底栏的 InlineSelect 里。把它们合成一个控件会产生 9 种组合的解释负担。
 */
import { useCallback, useEffect, useState } from 'react';

import { Composer, type ComposerProps, type SelectOption } from '../components/composer.js';
import {
  CaseCard,
  FilterChipRow,
  IconButton,
  PillButton,
  ScenarioChip,
  SectionHeader,
  SegmentedControl,
} from '../components/primitives.js';

export interface ScenarioChipSpec {
  readonly label: string;
  readonly icon?: string | undefined;
  /** 点击时写入 Composer 的提示词（**不发送**，03 §3.2） */
  readonly prompt: string;
  /** 声明后点击同时打开文件选择器 */
  readonly requiresFile?: boolean | undefined;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly icon?: string | undefined;
  readonly chips: readonly ScenarioChipSpec[];
  /** 场景默认值，切换时把未被用户改过的控件回落到这里（03 §2.5） */
  readonly defaults: {
    readonly modelId?: string | undefined;
    readonly permissionId?: string | undefined;
    readonly mode?: 'craft' | 'plan' | 'ask' | undefined;
    readonly workspaceId?: string | undefined;
  };
}

export interface CaseSpec {
  readonly id: string;
  readonly title: string;
  readonly cover?: string | undefined;
  readonly prompt: string;
  readonly scenarioId?: string | undefined;
}

/** 03 §6 / Q18：四个插槽，只有 showcase 默认开，且**只渲染静态内容，禁任何行为回传**。 */
export interface SlotConfig {
  readonly titlebarPromo?: boolean | undefined;
  readonly activityPopover?: boolean | undefined;
  readonly sidebarPromo?: boolean | undefined;
  readonly showcase?: boolean | undefined;
}

export const DEFAULT_SLOTS: SlotConfig = Object.freeze({
  titlebarPromo: false,
  activityPopover: false,
  sidebarPromo: false,
  showcase: true,
});

/** 03 §3.2：最多渲染 8 个 chip，其余走横向滚动。快捷键 ⌥1–⌥8。 */
export const MAX_CHIPS = 8;

export interface HomeProps {
  readonly heroLine: string;
  readonly scenarios: readonly Scenario[];
  readonly scenarioId: string;
  readonly onScenarioChange: (id: string) => void;
  readonly cases?: readonly CaseSpec[] | undefined;
  readonly onShuffleCases?: (() => void) | undefined;
  readonly slots?: SlotConfig | undefined;
  readonly onPickFile?: (() => void) | undefined;
  /** Composer 的全部接线原样透传 —— 首页与任务页共用同一个组件（03 §4.6） */
  readonly composer: Omit<ComposerProps, 'value' | 'onChange'>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** 场景配置损坏时回落到内置 office 并提示，不白屏（03 §8） */
  readonly configNotice?: string | undefined;
}

export function Home(props: HomeProps) {
  const slots = { ...DEFAULT_SLOTS, ...(props.slots ?? {}) };
  const scenario = props.scenarios.find((s) => s.id === props.scenarioId) ?? props.scenarios[0];
  const [showcaseClosed, setShowcaseClosed] = useState(false);
  const { onChange } = props;

  const writePrompt = useCallback(
    (prompt: string) => {
      // 03 §3.2 / §5：写入并聚焦，**不自动发送**
      onChange(prompt);
      const box = document.querySelector<HTMLTextAreaElement>('.ew-composer-textarea');
      box?.focus();
      box?.setSelectionRange(prompt.length, prompt.length);
    },
    [onChange],
  );

  // ⌥1–⌥8 对应前 8 个 chip（03 §3.2）
  const chips = (scenario?.chips ?? []).slice(0, MAX_CHIPS);
  const onPickFile = props.onPickFile;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const index = Number.parseInt(event.key, 10) - 1;
      const chip = chips[index];
      if (!Number.isFinite(index) || !chip) return;
      event.preventDefault();
      writePrompt(chip.prompt);
      if (chip.requiresFile) onPickFile?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chips, writePrompt, onPickFile]);

  const cases = (props.cases ?? []).filter(
    (c) => c.scenarioId === undefined || c.scenarioId === scenario?.id,
  );

  return (
    <div className="ew-home">
      {/* Q18：插槽只渲染静态内容。这里连 onClick 埋点都不接 —— 接了就等于开了回传通道 */}
      {slots.titlebarPromo ? <div className="ew-slot" data-slot="titlebar-promo" /> : null}

      <div className="ew-content-column">
        {props.configNotice ? <p className="ew-config-notice">{props.configNotice}</p> : null}

        <h1 className="ew-hero">{props.heroLine}</h1>

        {/* 深色变体：**决定页面装什么**（01 §5.9 / §5.10 的硬规则） */}
        <SegmentedControl
          variant="dark"
          ariaLabel="场景"
          value={scenario?.id ?? ''}
          items={props.scenarios.map((s) => ({ id: s.id, label: s.name, icon: s.icon }))}
          onChange={props.onScenarioChange}
        />

        <FilterChipRow ariaLabel="场景推荐">
          {chips.map((chip, index) => (
            <ScenarioChip
              key={chip.label}
              label={chip.label}
              icon={chip.icon}
              shortcut={index < MAX_CHIPS ? `⌥${index + 1}` : undefined}
              onClick={() => {
                writePrompt(chip.prompt);
                if (chip.requiresFile) props.onPickFile?.();
              }}
            />
          ))}
        </FilterChipRow>

        <Composer {...props.composer} value={props.value} onChange={props.onChange} />

        {slots.showcase && !showcaseClosed && cases.length > 0 ? (
          <section className="ew-showcase" aria-label="最佳实践案例">
            <SectionHeader
              title="不知道做什么，试试最佳实践案例"
              actions={
                <>
                  <PillButton variant="ghost" onClick={props.onShuffleCases}>
                    换一批
                  </PillButton>
                  <IconButton label="关闭案例区" icon="✕" onClick={() => setShowcaseClosed(true)} />
                </>
              }
            />
            <div className="ew-case-grid">
              {cases.slice(0, 4).map((item) => (
                <CaseCard
                  key={item.id}
                  title={item.title}
                  cover={item.cover}
                  onClick={() => writePrompt(item.prompt)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 场景切换时算出新的选择器取值（03 §2.5）。
 *
 * 规则：**用户显式改过的控件保留用户的值**，其余回落到新场景默认值。
 * 抽成纯函数是因为这条规则有四个入参、三个出参，混在组件里没法单独验；
 * 而它错了的表现（"我明明选了 Ask，换个场景就变回 Craft"）用户一定会撞上。
 */
export function applyScenarioDefaults(
  scenario: Scenario,
  current: {
    modelId?: string | undefined;
    permissionId?: string | undefined;
    mode?: 'craft' | 'plan' | 'ask' | undefined;
  },
  overrides: Readonly<Partial<Record<'model' | 'permission' | 'mode', boolean>>>,
): {
  modelId?: string | undefined;
  permissionId?: string | undefined;
  mode?: 'craft' | 'plan' | 'ask' | undefined;
} {
  return {
    modelId: overrides.model ? current.modelId : scenario.defaults.modelId,
    permissionId: overrides.permission ? current.permissionId : scenario.defaults.permissionId,
    mode: overrides.mode ? current.mode : scenario.defaults.mode,
  };
}

/** 权限档位 → 选择器选项。`allowed:false` 保留并给原因（F4 / 10 §2）。 */
export function toPermissionOptions(
  profiles: readonly { id: string; description?: string | undefined; allowed: boolean }[],
  labelOf: (id: string) => string,
): readonly SelectOption[] {
  return profiles.map((p) => ({
    id: p.id,
    label: labelOf(p.id),
    description: p.description,
    allowed: p.allowed,
    disabledReason: p.allowed ? undefined : '已被企业策略锁定',
  }));
}
