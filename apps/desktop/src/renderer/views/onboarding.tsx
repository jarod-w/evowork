/**
 * 首次运行与授权引导（02 §9）。
 *
 * ```
 * ① 欢迎 + 隐私说明   ② 选工作空间   ③ 权限默认值
 * ④ 模型接入          ⑤ 解析运行时（可跳过）   ⑥ 完成
 * ```
 *
 * ## 两条把这一页从"走过场"变成"有用"的规则
 *
 * 1. **第 ⑤ 步必须允许跳过并明确后果**（02 §9 / R10）。300MB 下载挡在首次体验前面
 *    会让人在还没看到产品之前就流失。所以它是"可跳过 + 说清跳过之后哪类文件用不了"，
 *    而不是"建议安装"。
 * 2. **第 ① 屏的措辞不得夸大**。它是 Q3 承诺的对外表达，要与网关的不落盘承诺（Q14）一致 ——
 *    **不能写成"完全不出网"**：模型调用是要出网的。写错这句话比不写更糟。
 */

import { RUNTIME_TIERS } from '@evowork/ingest';
import { toProfileOptions, type ProtocolProfile } from '@evowork/policy';

import { Banner, EmptyState, PillButton, SegmentedControl } from '../components/primitives.js';

export type OnboardingStep = 'welcome' | 'workspace' | 'permissions' | 'model' | 'runtime' | 'done';

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'welcome',
  'workspace',
  'permissions',
  'model',
  'runtime',
  'done',
];

export const STEP_TITLE: Readonly<Record<OnboardingStep, string>> = Object.freeze({
  welcome: '欢迎使用 EvoWork',
  workspace: '选一个工作空间',
  permissions: '默认权限',
  model: '接入模型',
  runtime: '文档解析组件',
  done: '好了',
});

/**
 * 第 ① 屏的两句话 —— **Q3 的对外表达，措辞不可放宽也不可夸大**。
 *
 * 「执行都在本机」与「模型调用会出网」两件事都要讲清。少讲第二件是骗人；
 * 把第一件说成"完全不出网"同样是骗人 —— 而用户迟早会从抓包或账单里发现。
 */
export const PRIVACY_STATEMENT = Object.freeze([
  '**文件处理、命令执行、定时任务都在这台电脑上完成。** 文档解析不会把你的原始文件传到云上。',
  '**模型调用需要联网。** 你的提问和相关上下文会发给你选择的模型服务商；EvoWork 的网关不保存这些内容。',
]);

export interface OnboardingProps {
  readonly step: OnboardingStep;
  readonly onStepChange: (step: OnboardingStep) => void;
  readonly workspaces: readonly string[];
  readonly onPickWorkspace?: (() => void) | undefined;
  readonly permissionProfiles: readonly ProtocolProfile[];
  readonly permissionId?: string | undefined;
  readonly onPermissionChange?: ((id: string) => void) | undefined;
  readonly modelStatus: 'unchecked' | 'checking' | 'ok' | 'failed';
  readonly modelError?: string | undefined;
  readonly onCheckModel?: (() => void) | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly onGatewayUrlChange?: ((url: string) => void) | undefined;
  readonly runtimeInstalled: boolean;
  readonly onInstallRuntime?: (() => void) | undefined;
  readonly onSkipRuntime?: (() => void) | undefined;
  readonly onFinish?: (() => void) | undefined;
}

export function Onboarding(props: OnboardingProps) {
  const index = ONBOARDING_STEPS.indexOf(props.step);

  return (
    <div className="ew-onboarding">
      <div className="ew-content-column">
        <p className="ew-onboarding-progress">
          第 {index + 1} / {ONBOARDING_STEPS.length} 步
        </p>
        <h1 className="ew-onboarding-title">{STEP_TITLE[props.step]}</h1>

        {props.step === 'welcome' ? <Welcome /> : null}
        {props.step === 'workspace' ? <Workspace {...props} /> : null}
        {props.step === 'permissions' ? <Permissions {...props} /> : null}
        {props.step === 'model' ? <Model {...props} /> : null}
        {props.step === 'runtime' ? <Runtime {...props} /> : null}
        {props.step === 'done' ? <Done /> : null}

        <Footer {...props} index={index} />
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="ew-onboarding-body">
      {PRIVACY_STATEMENT.map((line) => (
        <p key={line} className="ew-privacy-line">
          {line.replace(/\*\*/g, '')}
        </p>
      ))}
      <p className="ew-field-hint">这两句话在设置里随时能再看到，也能查到具体哪些动作会联网。</p>
    </div>
  );
}

function Workspace(props: OnboardingProps) {
  return (
    <div className="ew-onboarding-body">
      <p>
        EvoWork 只能读写你选中的目录。<strong>没有选中的地方它碰不到</strong>，
        系统目录和密钥所在的位置则永远碰不到。
      </p>
      {props.workspaces.length === 0 ? (
        <EmptyState
          title="还没有选目录"
          hint="选一个平时放工作文件的文件夹，之后随时可以再加。"
          action={
            <PillButton variant="accent" onClick={props.onPickWorkspace}>
              选择文件夹
            </PillButton>
          }
        />
      ) : (
        <>
          <ul className="ew-onboarding-list">
            {props.workspaces.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <PillButton onClick={props.onPickWorkspace}>再加一个</PillButton>
        </>
      )}
    </div>
  );
}

function Permissions(props: OnboardingProps) {
  const options = toProfileOptions(props.permissionProfiles);
  return (
    <div className="ew-onboarding-body">
      <p>这决定 agent 默认能做到什么程度。每个任务都可以单独改。</p>
      <SegmentedControl
        variant="light"
        ariaLabel="默认权限"
        value={props.permissionId ?? 'evowork-workspace'}
        items={options
          .filter((option) => option.allowed && option.id !== 'evowork-full')
          .map((option) => ({ id: option.id, label: option.name }))}
        onChange={(id) => props.onPermissionChange?.(id)}
      />
      <p className="ew-field-hint">
        {
          options.find((option) => option.id === (props.permissionId ?? 'evowork-workspace'))
            ?.summary
        }
      </p>
      {/* 完全访问不在这一步给：它要过二次确认，且只对单个任务生效（10 §2.2） */}
      <p className="ew-field-hint">
        「完全访问」不在这里设 —— 它需要单独确认，而且只对当次任务生效。
      </p>
    </div>
  );
}

function Model(props: OnboardingProps) {
  return (
    <div className="ew-onboarding-body">
      <label className="ew-field">
        <span>模型网关地址</span>
        <input
          value={props.gatewayUrl ?? ''}
          placeholder="https://gateway.evowork.example/v1"
          onChange={(event) => props.onGatewayUrlChange?.(event.target.value)}
        />
        <span className="ew-field-hint">
          企业私有部署填自己的地址。密钥从环境变量读，不写进配置文件。
        </span>
      </label>

      <PillButton variant="accent" onClick={props.onCheckModel}>
        {props.modelStatus === 'checking' ? '检查中…' : '检查连通性'}
      </PillButton>

      {props.modelStatus === 'ok' ? <Banner tone="info">连上了，可以用。</Banner> : null}
      {props.modelStatus === 'failed' ? (
        // 不静默降级到别的模型（03 §8）：这里就把话说死
        <Banner tone="danger">
          {props.modelError ?? '连不上这个网关。'}没有可用的模型时任务发不出去， EvoWork
          不会自动换一个模型。
        </Banner>
      ) : null}
    </div>
  );
}

function Runtime(props: OnboardingProps) {
  const office = RUNTIME_TIERS.office;
  return (
    <div className="ew-onboarding-body">
      <p>
        处理 Word / Excel / PPT / PDF，以及生成这些格式的文件，需要一个本地组件 （{office.label}，
        {office.size}）。
      </p>
      {props.runtimeInstalled ? (
        <Banner tone="info">已经装好了。</Banner>
      ) : (
        <>
          <div className="ew-onboarding-actions">
            <PillButton variant="accent" onClick={props.onInstallRuntime}>
              现在安装
            </PillButton>
            {/* R10：必须允许跳过，且**明确后果** —— 不是"建议安装" */}
            <PillButton onClick={props.onSkipRuntime}>以后再说</PillButton>
          </div>
          <p className="ew-field-hint">
            跳过也能正常用：文本、Markdown、CSV、JSON、压缩包都不需要它。
            <strong>只有 Word / Excel / PPT / PDF 会暂时用不了</strong>， 第一次遇到时会再问你一次。
          </p>
        </>
      )}
    </div>
  );
}

function Done() {
  return (
    <div className="ew-onboarding-body">
      <p>可以开始了。第一个任务建议先让它读点东西，比如「看看这个目录里有什么」。</p>
    </div>
  );
}

/**
 * 底栏。
 *
 * 「下一步」在**必填项没填**时禁用并给原因（01 §6.3：禁用要配 tooltip 说明原因）——
 * 一个灰着的按钮不告诉用户为什么灰，比不给按钮更让人困惑。
 */
function Footer(props: OnboardingProps & { readonly index: number }) {
  const blocked = blockingReason(props);
  const isLast = props.step === 'done';

  return (
    <div className="ew-onboarding-footer">
      {props.index > 0 && !isLast ? (
        <PillButton
          onClick={() => props.onStepChange(ONBOARDING_STEPS[props.index - 1] as OnboardingStep)}
        >
          上一步
        </PillButton>
      ) : null}
      <PillButton
        variant="accent"
        disabled={blocked !== undefined}
        disabledReason={blocked}
        onClick={() =>
          isLast
            ? props.onFinish?.()
            : props.onStepChange(ONBOARDING_STEPS[props.index + 1] as OnboardingStep)
        }
      >
        {isLast ? '开始使用' : '下一步'}
      </PillButton>
    </div>
  );
}

/** 挡住「下一步」的原因。**返回 undefined 表示可以继续**。 */
export function blockingReason(props: {
  readonly step: OnboardingStep;
  readonly workspaces: readonly string[];
  readonly modelStatus: OnboardingProps['modelStatus'];
}): string | undefined {
  if (props.step === 'workspace' && props.workspaces.length === 0) {
    return '先选一个工作空间 —— EvoWork 只能读写你选中的目录。';
  }
  if (props.step === 'model' && props.modelStatus !== 'ok') {
    return '先确认模型能连上，否则第一个任务就会失败。';
  }
  // 第 ⑤ 步**不阻塞**（R10）：可跳过是它的设计要求，不是妥协
  return undefined;
}

/** 首运行完成后写入的默认值（02 §9 第 ⑥ 步：Composer 已预选刚建的工作空间）。 */
export interface OnboardingResult {
  readonly workspaces: readonly string[];
  readonly defaultPermissionId: string;
  readonly gatewayUrl?: string | undefined;
  readonly officeRuntimeInstalled: boolean;
}

export function toResult(props: OnboardingProps): OnboardingResult {
  return {
    workspaces: props.workspaces,
    defaultPermissionId: props.permissionId ?? 'evowork-workspace',
    ...(props.gatewayUrl ? { gatewayUrl: props.gatewayUrl } : {}),
    officeRuntimeInstalled: props.runtimeInstalled,
  };
}
