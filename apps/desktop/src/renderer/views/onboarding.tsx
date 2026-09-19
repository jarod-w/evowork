/**
 * 首次运行与授权引导（02 §9）。
 *
 * ```
 * ① 欢迎 + 隐私说明   ② 选项目   ③ 解析运行时（可跳过）   ④ 完成
 * ```
 *
 * 「权限默认值」暂时不进引导：选了既不写 `default_permissions`，也不进 `turn/start`，
 * 实际任务始终用场景包的 `evowork-workspace`。接上发送链路后再加回来。
 *
 * 模型不在引导里配：走完之后去「设置 → 模型」添加。没配模型时 Composer 顶部会挡住发送，
 * 不会静默换一个（03 §8）。
 *
 * ## 两条把这一页从"走过场"变成"有用"的规则
 *
 * 1. **第 ③ 步必须允许跳过并明确后果**（02 §9 / R10）。300MB 下载挡在首次体验前面
 *    会让人在还没看到产品之前就流失。所以它是"可跳过 + 说清跳过之后哪类文件用不了"，
 *    而不是"建议安装"。
 * 2. **第 ① 屏的措辞不得夸大**。它是 Q3 承诺的对外表达，要与网关的不落盘承诺（Q14）一致 ——
 *    **不能写成"完全不出网"**：模型调用是要出网的。写错这句话比不写更糟。
 */

/*
 * **深路径，不走两个包的 barrel。**
 *
 * `@evowork/ingest` 的 index 会带出 `probe.ts`（`node:child_process` / `node:fs` / `node:os`）
 * —— 渲染进程是浏览器环境，vite 打包时直接失败。这个文件本身是纯的（一份常量表），
 * 深路径拿它没有代价。
 *
 * 这条在这一页被挂进 `app.tsx` 之前看不见：它从没进过渲染层的 bundle。
 */
import { RUNTIME_TIERS } from '@evowork/ingest/runtime.js';

import { Banner, EmptyState, PillButton, ProgressBar } from '../components/primitives.js';

export type OnboardingStep = 'welcome' | 'workspace' | 'runtime' | 'done';

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'welcome',
  'workspace',
  'runtime',
  'done',
];

export const STEP_TITLE: Readonly<Record<OnboardingStep, string>> = Object.freeze({
  welcome: '欢迎使用 EvoWork',
  workspace: '选一个项目',
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
  readonly gatewayUrl?: string | undefined;
  readonly onGatewayUrlChange?: ((url: string) => void) | undefined;
  readonly runtimeInstalled: boolean;
  /**
   * 这台机器支不支持（架构没有对应的运行时时为 false）。
   *
   * **不支持时不显示安装按钮** —— 显示一个点了必然失败的按钮，比明说"这台机器上用不了"
   * 更糟：用户会反复点，然后以为是网络问题。
   */
  readonly runtimeSupported?: boolean | undefined;
  /** 要下多少（如 "约 25 MB"）。**按平台算**，linux x64 是 macOS 的四倍 */
  readonly runtimeDownloadSize?: string | undefined;
  /** 正在装时的进度。`undefined` = 没在装 */
  readonly runtimeProgress?:
    | { readonly label: string; readonly percent: number; readonly detail?: string | undefined }
    | undefined;
  /** 上一次安装失败的原因，可直接显示 */
  readonly runtimeError?: string | undefined;
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

function Runtime(props: OnboardingProps) {
  const office = RUNTIME_TIERS.office;
  const installing = props.runtimeProgress !== undefined;
  // 探测结果没到之前按"支持"渲染：默认成不支持的话，界面会在半秒里先说
  // "这台机器用不了"再改口，而那半秒足够被看见
  const supported = props.runtimeSupported ?? true;

  return (
    <div className="ew-onboarding-body">
      <p>
        处理 Word / Excel / PPT / PDF，以及生成这些格式的文件，需要一个本地组件 （{office.label}，
        {props.runtimeDownloadSize ?? office.size}）。它还带一份中文字体，
        图表里的中文才不会变成方框。
      </p>

      {props.runtimeInstalled ? (
        <Banner tone="info">已经装好了。</Banner>
      ) : !supported ? (
        /* 不支持的平台：**说清楚，不给按钮** —— 点了必然失败的按钮只会让人反复点 */
        <Banner tone="danger">
          这台设备的系统架构暂时没有可用的{office.label}。 Word / Excel / PPT / PDF
          在这台机器上用不了，其余功能不受影响。
        </Banner>
      ) : installing ? (
        <div className="ew-onboarding-progress-block">
          {/*
            进度条 + 阶段名 + 字节数。三样都要：只有百分比的话，卡在 40% 的那两分钟
            （pip 装包，没有细粒度进度）看起来像死了。
          */}
          <ProgressBar
            percent={props.runtimeProgress?.percent ?? 0}
            label={props.runtimeProgress?.label ?? '正在安装办公扩展'}
          />
          <p className="ew-field-hint">
            {props.runtimeProgress?.label}
            {props.runtimeProgress?.detail ? ` · ${props.runtimeProgress.detail}` : ''}
          </p>
          <p className="ew-field-hint">装的时候可以先往下走，装完了会自己生效。</p>
        </div>
      ) : (
        <>
          {props.runtimeError !== undefined ? (
            // 失败原因照原样给：安装器已经把它写成一句能照做的话了（换网络 / 用离线包 / 清磁盘）
            <Banner tone="danger">{props.runtimeError}</Banner>
          ) : null}
          <div className="ew-onboarding-actions">
            <PillButton variant="accent" onClick={props.onInstallRuntime}>
              {props.runtimeError !== undefined ? '重试安装' : '现在安装'}
            </PillButton>
            {/* R10：必须允许跳过，且**明确后果** —— 不是"建议安装"（现在是第 ③ 步） */}
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
      <p>
        可以开始了。模型在「设置 →
        模型」里添加，配好之后就能发任务。第一个任务建议先让它读点东西，比如「看看这个目录里有什么」。
      </p>
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
}): string | undefined {
  if (props.step === 'workspace' && props.workspaces.length === 0) {
    return '先选一个项目 —— EvoWork 只能读写你选中的目录。';
  }
  // 第 ③ 步**不阻塞**（R10）：可跳过是它的设计要求，不是妥协
  return undefined;
}
