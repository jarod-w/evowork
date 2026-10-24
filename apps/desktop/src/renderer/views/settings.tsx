import { memoryPreparationLabel } from '../components/memory-preparation.js';
import { MemoryImportOverview, type MemoryImportPorts } from '../components/memory-import.js';
import { ImageSettings, type ImageUiPorts } from '../components/image-settings.js';
import type { ComputerUseStatusView } from '../../shared/ipc.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  SettingsRow,
  SettingsFeedback,
  useSettingsAction,
  type SettingsFormState,
  type SettingsLeaveGuard,
} from '../components/settings-controls.js';

import { renderIcon } from '../components/icons.js';
import { InlineSelect, Menu, Popover } from '../components/menu.js';
import { TextTabs, PanelNavItem } from '../components/panels.js';
import {
  Banner,
  Dialog,
  EmptyState,
  IconButton,
  PillButton,
  ProgressBar,
  SectionHeader,
} from '../components/primitives.js';
import type {
  ContextPolicyView,
  HubStatusView,
  CustomModelInput,
  CustomModelTestInput,
  CustomModelUpdateInput,
  CustomModelView,
  KnownContextView,
  ModelAccessView,
  ModelProbeResult,
  MemorySettingsInput,
  MemorySettingsView,
  PreferencesView,
  WorkingDirectoryView,
  RuntimeProgressView,
  RuntimeStatusView,
  UpdateQuitImpactView,
  UpdateStatusView,
} from '../../shared/ipc.js';

export type SettingsSection =
  | 'general'
  | 'account'
  | 'models'
  | 'import'
  | 'personalization'
  | 'usage'
  | 'data'
  | 'security'
  | 'about';

export const SETTINGS_SECTIONS: readonly {
  readonly id: SettingsSection;
  readonly label: string;
}[] = [
  { id: 'general', label: '常规' },
  { id: 'account', label: '账号' },
  { id: 'models', label: '模型' },
  { id: 'personalization', label: '记忆与导入' },
  { id: 'usage', label: '用量与预算' },
  { id: 'security', label: '安全与权限' },
  { id: 'about', label: '关于与更新' },
];

/** 密钥存在哪 → 人话（11 §4.3）。明文兜底必须**看起来就是一种降级**。 */
export const BACKEND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  keychain: '钥匙串（macOS）',
  dpapi: 'Windows 凭据保护（DPAPI）',
  libsecret: '系统密钥环（libsecret）',
  'plaintext-fallback': '明文文件（你选择的兜底方式）',
  unavailable: '未保存 —— 这台电脑上没有可用的系统密钥库',
});

export interface SettingsPageProps {
  readonly onOpenLibrary?: (() => void) | undefined;
  readonly onOpenAudit?: (() => void) | undefined;
  readonly onRegisterLeaveGuard?: ((guard: SettingsLeaveGuard | null) => void) | undefined;
  readonly workingDirectory?: WorkingDirectoryView | null | undefined;
  readonly workingDirectoryBusy?: boolean | undefined;
  readonly onWorkingDirectory?: ((reset: boolean) => void | Promise<void>) | undefined;
  readonly imagePorts?: ImageUiPorts | undefined;
  readonly computerUse?: ComputerUseStatusView | null | undefined;
  readonly onComputerUseEnabled?: ((enabled: boolean) => void | Promise<void>) | undefined;
  readonly onComputerUseStop?: (() => void) | undefined;
  readonly onComputerUseRevoke?: ((appId?: string) => void | Promise<void>) | undefined;
  readonly onComputerUseSettings?:
    ((permission?: 'accessibility' | 'screenRecording') => void) | undefined;
  readonly onComputerUseRefresh?: (() => void | Promise<void>) | undefined;

  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly access: ModelAccessView | null;
  readonly preferences: PreferencesView | null;
  readonly memory: MemorySettingsView | null;
  readonly memoryImportPorts?: MemoryImportPorts | undefined;
  readonly memoryImportRevision?: number | undefined;
  readonly onImportMemories?: (() => void) | undefined;
  readonly appName: string;
  readonly appVersion: string;
  /** 上一次动作被拒绝的原话。**显示出来**，不吞掉 */
  readonly refusal?: string | undefined;
  readonly probeResult?: string | undefined;
  readonly onAddCustomModel: (input: CustomModelInput) => void | Promise<void>;
  /** 改一条已存在的（行内铅笔）。留空的密钥字段 = 不动已存的那把 */
  readonly onUpdateCustomModel: (input: CustomModelUpdateInput) => void | Promise<void>;
  readonly onRemoveCustomModel: (id: string) => void | Promise<void>;
  /**
   * 保存之前的「测试连接」。**返回 Promise 而不是走统一的 `onModelAccessAction`**：
   * 它不改任何本机状态，结果要回到弹窗里那一行，而不是页顶的横幅。
   */
  readonly onTestCustomModel: (input: CustomModelTestInput) => Promise<ModelProbeResult>;
  /** 在访达里打开 `models.toml` 所在目录。没注入 `shell` 时缺席，链接**禁用** */
  readonly onOpenModelsFolder?: (() => void) | undefined;
  /** 「查看文档」。渲染层只递 provider id，URL 白名单在主进程（11 §6.3） */
  readonly onOpenProviderDocs?: ((provider: string) => void) | undefined;
  readonly onSecretFallback: (accept: boolean) => void | Promise<void>;
  readonly onProbe: (modelId: string) => void;
  readonly onPreferences: (input: {
    taskTokenBudget?: number;
    concurrencyLimit?: number;
  }) => void | Promise<void>;
  readonly onMemorySettings: (input: MemorySettingsInput) => void | Promise<void>;
  readonly onResetMemories: () => void | Promise<void>;
  readonly onLogin?: () => void;
  readonly onLogout?: () => void;
  readonly onRevokeDevice?: (deviceId: string) => void;
  readonly onOpenAccountWeb?: (path: string) => void;
  /** 插件 Hub 的状态（13 §5.6）。没加载时缺席，开关不出现。 */
  readonly hubStatus?: HubStatusView | undefined;
  readonly onHubFetchWhenSignedOut?: ((enabled: boolean) => void | Promise<void>) | undefined;
  /* 关于与更新（在线升级提案 §4 B4 · 总纲 Q46）。不给时那一块如实说「还没接上」 */
  readonly update?: UpdateStatusView | null | undefined;
  readonly onCheckUpdate?: (() => void) | undefined;
  readonly onDownloadUpdate?: (() => void) | undefined;
  readonly onCancelUpdateDownload?: (() => void) | undefined;
  readonly onUpdateAutoCheck?: ((enabled: boolean) => void | Promise<void>) | undefined;
  readonly onGetUpdateQuitImpact?: (() => Promise<UpdateQuitImpactView>) | undefined;
  readonly onQuitAndInstall?: (() => void) | undefined;
  /* 办公扩展的版本（A4）：装着但不是这一版要的组件时，在这里说并给「重新安装」 */
  readonly runtime?: RuntimeStatusView | null | undefined;
  readonly runtimeProgress?: RuntimeProgressView | undefined;
  readonly runtimeError?: string | undefined;
  readonly onInstallRuntime?: (() => void) | undefined;
}

export function normalizeSettingsSection(section: SettingsSection): SettingsSection {
  return section === 'import' ? 'personalization' : section === 'data' ? 'general' : section;
}

export function SettingsPage(props: SettingsPageProps) {
  const section = normalizeSettingsSection(props.section);
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (page.current) page.current.scrollTop = 0;
  }, [section]);
  const [modelTab, setModelTab] = useState('chat');
  const [resetRevision, setResetRevision] = useState(0);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const forms = useRef<Record<string, SettingsFormState>>({});
  const leaveResolve = useRef<((allowed: boolean) => void) | null>(null);
  const leavePromise = useRef<Promise<boolean> | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const imageState = useCallback((state: SettingsFormState) => {
    forms.current.image = state;
    setFormRevision((value) => value + 1);
  }, []);
  const budgetState = useCallback((state: SettingsFormState) => {
    forms.current.budget = state;
    setFormRevision((value) => value + 1);
  }, []);
  const requestLeave = useCallback((): Promise<boolean> => {
    if (!Object.values(forms.current).some((form) => form.dirty || form.busy))
      return Promise.resolve(true);
    if (leavePromise.current) return leavePromise.current;
    leavePromise.current = new Promise((resolve) => {
      leaveResolve.current = resolve;
    });
    setLeavePrompt(true);
    return leavePromise.current;
  }, []);
  useEffect(() => {
    props.onRegisterLeaveGuard?.(requestLeave);
    return () => {
      props.onRegisterLeaveGuard?.(null);
      leaveResolve.current?.(false);
    };
  }, [props.onRegisterLeaveGuard, requestLeave]);
  const navigate = (next: SettingsSection) => {
    if (normalizeSettingsSection(next) === section) return;
    void requestLeave().then((allowed) => {
      if (allowed) props.onSection(next);
    });
  };
  const busy = Object.values(forms.current).some((form) => form.busy);
  const finishLeave = (allowed: boolean) => {
    if (allowed && busy) return;
    if (allowed) {
      forms.current = {};
      setResetRevision((value) => value + 1);
    }
    const resolve = leaveResolve.current;
    leaveResolve.current = null;
    leavePromise.current = null;
    setLeavePrompt(false);
    resolve?.(allowed);
  };
  useEffect(() => {
    if (!leavePrompt || Object.values(forms.current).some((form) => form.dirty || form.busy))
      return;
    const resolve = leaveResolve.current;
    leaveResolve.current = null;
    leavePromise.current = null;
    setLeavePrompt(false);
    resolve?.(true);
  }, [formRevision, leavePrompt]);
  return (
    <div ref={page} className="ew-page ew-settings">
      <nav className="ew-settings-nav" aria-label="设置分类">
        <h2 className="ew-settings-nav-title">设置</h2>
        {SETTINGS_SECTIONS.map((item) => (
          <PanelNavItem
            key={item.id}
            label={item.label}
            selected={section === item.id}
            badge={
              item.id === 'about' &&
              (props.update?.phase === 'available' || props.update?.phase === 'ready')
            }
            onClick={() => navigate(item.id)}
          />
        ))}
      </nav>
      <div className="ew-settings-body">
        <div className="ew-settings-mobile-nav">
          <InlineSelect
            ariaLabel="设置分类"
            placeholder="设置"
            value={section}
            options={SETTINGS_SECTIONS.map((item) => ({
              id: item.id,
              label:
                item.label +
                (item.id === 'about' &&
                (props.update?.phase === 'available' || props.update?.phase === 'ready')
                  ? ' · 有更新'
                  : ''),
            }))}
            onChange={(id) => navigate(id as SettingsSection)}
          />
        </div>
        {props.refusal !== undefined ? <Banner tone="danger">{props.refusal}</Banner> : null}
        {section === 'general' ? <GeneralSection {...props} /> : null}
        {section === 'account' ? <AccountSection {...props} /> : null}
        {section === 'models' ? (
          <>
            <header className="ew-settings-page-head">
              <h1>模型</h1>
              <p className="ew-settings-note">管理对话与图片使用的模型服务。</p>
            </header>
            <TextTabs
              ariaLabel="模型类型"
              items={[
                { id: 'chat', label: '对话模型' },
                { id: 'image', label: '图片模型' },
              ]}
              value={modelTab}
              onChange={(next) => {
                if (next !== modelTab)
                  void requestLeave().then((allowed) => {
                    if (allowed) setModelTab(next);
                  });
              }}
            />
            <div hidden={modelTab !== 'chat'} role="tabpanel" aria-label="对话模型">
              <ModelsSection {...props} />
            </div>
            <div hidden={modelTab !== 'image'} role="tabpanel" aria-label="图片模型">
              <ImageSettings
                ports={props.imagePorts}
                resetRevision={resetRevision}
                onFormState={imageState}
              />
            </div>
          </>
        ) : null}
        {section === 'personalization' ? <MemorySection {...props} /> : null}
        {section === 'usage' ? (
          <UsageSection {...props} resetRevision={resetRevision} onFormState={budgetState} />
        ) : null}
        {section === 'security' ? <SecuritySection {...props} /> : null}
        {section === 'about' ? <AboutSection {...props} /> : null}
      </div>
      {leavePrompt ? (
        <Dialog
          title={busy ? '正在保存设置' : '设置尚未保存'}
          confirmLabel="丢弃并离开"
          confirmDisabled={busy}
          onCancel={() => finishLeave(false)}
          onConfirm={() => finishLeave(true)}
        >
          <p>{busy ? '请等待本次保存完成后再离开。' : '离开将丢弃本次未保存的修改。'}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function GeneralSection(props: SettingsPageProps) {
  const action = useSettingsAction();
  const [pendingHub, setPendingHub] = useState<boolean | null>(null);
  return (
    <section className="ew-settings-section">
      <header className="ew-settings-page-head">
        <h1>常规</h1>
        <p className="ew-settings-note">管理这台电脑上的工作目录与本地数据。</p>
      </header>
      <div className="ew-settings-group">
        <h3>工作目录</h3>
        <SettingsRow
          label="无项目任务的保存位置"
          description={
            props.workingDirectory ? (
              <p className="ew-settings-directory" title={props.workingDirectory.path}>
                {props.workingDirectory.path}
              </p>
            ) : (
              '正在读取工作目录…'
            )
          }
        >
          <PillButton
            disabled={
              !props.workingDirectory ||
              !props.onWorkingDirectory ||
              props.workingDirectoryBusy ||
              action.busy
            }
            onClick={() =>
              void action.run(
                () => props.onWorkingDirectory?.(false),
                '工作目录设置已确认，已有任务继续使用原目录。',
              )
            }
          >
            {props.workingDirectoryBusy ? '正在更改…' : '更改…'}
          </PillButton>
          <PillButton
            variant="ghost"
            disabled={
              !props.workingDirectory ||
              props.workingDirectory.isDefault ||
              !props.onWorkingDirectory ||
              props.workingDirectoryBusy ||
              action.busy
            }
            onClick={() => void action.run(() => props.onWorkingDirectory?.(true))}
          >
            恢复默认
          </PillButton>
        </SettingsRow>
        <p className="ew-settings-note">
          选择“不使用项目”时，在此目录中为每个新任务创建独立子目录，用于保存附件和产物。更改后仅对新任务生效，已有任务继续使用原目录。
        </p>
      </div>
      <div className="ew-settings-group">
        <h3>本地数据</h3>
        <SettingsRow
          label="文件与存储管理"
          description="在资料库查看磁盘占用、管理文件和清理缓存。任务、产物和解析数据保存在本机。"
        >
          <PillButton disabled={!props.onOpenLibrary} onClick={props.onOpenLibrary}>
            前往资料库
          </PillButton>
        </SettingsRow>
      </div>
      {props.hubStatus ? (
        <div className="ew-settings-group">
          <h3>精选内容</h3>
          {props.access?.signedIn ? (
            <p className="ew-settings-note">登录后按当前组织策略获取精选内容。</p>
          ) : ['off', 'org-off', 'offline', 'unconfigured'].includes(props.hubStatus.fetchMode) ? (
            <p className="ew-settings-note">{props.hubStatus.caption ?? '当前不获取精选内容。'}</p>
          ) : (
            <SettingsRow
              label="未登录时获取 EvoWork 精选内容"
              htmlFor="settings-hub"
              description="仅下载目录与你选择安装的内容，不上传本地资料。"
            >
              <input
                id="settings-hub"
                type="checkbox"
                className="ew-settings-switch"
                checked={pendingHub ?? props.hubStatus.fetchWhenSignedOut}
                disabled={action.busy || !props.onHubFetchWhenSignedOut}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setPendingHub(enabled);
                  void action
                    .run(() => props.onHubFetchWhenSignedOut?.(enabled))
                    .finally(() => setPendingHub(null));
                }}
              />
            </SettingsRow>
          )}
        </div>
      ) : null}
      <SettingsFeedback feedback={action.feedback} />
    </section>
  );
}

/** 执行内核的本机记忆。内容由内核管理，产品只呈现受支持的控制与准备状态。 */
function MemorySection(props: SettingsPageProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const action = useSettingsAction();
  const memoryId = useId();
  const [pendingMemory, setPendingMemory] = useState<MemorySettingsView | null>(null);
  const memory = pendingMemory ?? props.memory;
  if (!memory) return <EmptyState title="正在读取记忆设置…" hint="" />;
  const update = (next: Partial<MemorySettingsInput>): void => {
    const input = {
      enabled: memory.enabled,
      useMemories: memory.useMemories,
      generateMemories: memory.generateMemories,
      disableOnExternalContext: memory.disableOnExternalContext,
      ...next,
    };
    setPendingMemory({
      ...memory,
      ...next,
      extractModel:
        next.extractModel === null ? undefined : (next.extractModel ?? memory.extractModel),
      consolidationModel:
        next.consolidationModel === null
          ? undefined
          : (next.consolidationModel ?? memory.consolidationModel),
      enabled: next.enabled ?? memory.enabled,
      useMemories: next.useMemories ?? memory.useMemories,
      generateMemories: next.generateMemories ?? memory.generateMemories,
      disableOnExternalContext: next.disableOnExternalContext ?? memory.disableOnExternalContext,
    });
    void action.run(() => props.onMemorySettings(input)).finally(() => setPendingMemory(null));
  };
  return (
    <section className="ew-settings-section">
      <header className="ew-settings-page-head">
        <h1>记忆与导入</h1>
        <p className="ew-settings-note">让后续任务延续你的工作习惯与项目上下文。</p>
      </header>
      <div className="ew-settings-group">
        <SettingsRow
          label="启用本地记忆"
          htmlFor={`${memoryId}-enabled`}
          description="记忆保存在这台电脑上。项目长期规则仍写在 AGENTS.md。"
        >
          <input
            id={`${memoryId}-enabled`}
            type="checkbox"
            className="ew-settings-switch"
            checked={memory.enabled}
            disabled={action.busy}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
        </SettingsRow>
        <div className="ew-settings-subrows">
          <SettingsRow
            label="在新任务中使用已有记忆"
            htmlFor={`${memoryId}-use`}
            description="新任务自动使用已整理的上下文。"
          >
            <input
              id={`${memoryId}-use`}
              type="checkbox"
              className="ew-settings-switch"
              checked={memory.useMemories}
              disabled={!memory.enabled || action.busy}
              onChange={(event) => update({ useMemories: event.target.checked })}
            />
          </SettingsRow>
          <SettingsRow
            label="允许任务生成新记忆"
            htmlFor={`${memoryId}-generate`}
            description="提取可复用信息，会调用模型并消耗用量。"
          >
            <input
              id={`${memoryId}-generate`}
              type="checkbox"
              className="ew-settings-switch"
              checked={memory.generateMemories}
              disabled={!memory.enabled || action.busy}
              onChange={(event) => update({ generateMemories: event.target.checked })}
            />
          </SettingsRow>
        </div>
        <p className="ew-settings-note" role="status">
          {memoryPreparationLabel(memory)}
        </p>
        <SettingsFeedback feedback={action.feedback} />
      </div>
      <div className="ew-settings-group">
        <h3>导入与同步</h3>
        <MemoryImportOverview
          refreshKey={props.memoryImportRevision}
          ports={props.memoryImportPorts ?? {}}
          onStart={() => props.onImportMemories?.()}
        />
      </div>
      <details className="ew-settings-details">
        <summary>高级设置</summary>
        <SettingsRow
          label="允许使用网页或连接器的任务贡献记忆"
          htmlFor={`${memoryId}-external`}
          description="默认排除使用网页或连接器的整个任务。开启后仅影响后续使用工具的任务，不会恢复此前已排除的任务。"
        >
          <input
            id={`${memoryId}-external`}
            type="checkbox"
            className="ew-settings-switch"
            checked={!memory.disableOnExternalContext}
            disabled={!memory.enabled || action.busy}
            onChange={(event) => update({ disableOnExternalContext: !event.target.checked })}
          />
        </SettingsRow>
        {(['extractModel', 'consolidationModel'] as const).map((key) => {
          const value = memory[key],
            models = props.access?.models ?? [];
          const label = key === 'extractModel' ? '记忆提取模型' : '记忆整理模型';
          return (
            <SettingsRow
              key={key}
              label={label}
              description={
                key === 'extractModel' ? '从任务中提取可复用信息。' : '合并与更新已有记忆。'
              }
            >
              <InlineSelect
                ariaLabel={label}
                placeholder={label}
                value={value ?? '@task'}
                disabled={!memory.enabled || action.busy}
                options={[
                  { id: '@task', label: '跟随任务模型' },
                  ...(value && !models.some((model) => model.id === value)
                    ? [{ id: value, label: `${value}（当前不可用）`, disabled: true }]
                    : []),
                  ...models.map((model) => ({
                    id: model.id,
                    label: model.label,
                    disabled: !!model.denied,
                    description:
                      model.denied ??
                      {
                        byok: '用户自有模型密钥',
                        hosted: '托管模型凭据',
                        private: '私有模型服务凭据',
                      }[model.credentialSource],
                  })),
                ]}
                onChange={(id) => update({ [key]: id === '@task' ? null : id })}
              />
            </SettingsRow>
          );
        })}
        <p className="ew-settings-note">
          提取和整理会调用模型并消耗用量。未指定时使用启动该后台流程的任务模型，修改对之后启动或恢复的任务生效。新任务可通过
          /memories 选择是否读取记忆；已有任务不能撤回已进入历史的记忆。
        </p>
        {!memory.taskModeSupported ? (
          <p className="ew-settings-note" role="status">
            当前版本不支持按任务调整记忆贡献，使用全局设置。
          </p>
        ) : null}
      </details>
      <div className="ew-settings-danger-zone">
        <SettingsRow
          label="清空本地记忆"
          description="删除已提取记忆，并关闭项目记忆自动同步。"
          danger
        >
          <PillButton
            variant="danger"
            disabled={!memory.resetSupported || action.busy}
            onClick={() => setConfirmReset(true)}
          >
            清空全部本地记忆
          </PillButton>
        </SettingsRow>
        {!memory.resetSupported ? (
          <p className="ew-settings-note" role="status">
            当前版本不支持清空全部本地记忆。
          </p>
        ) : null}
      </div>
      {confirmReset ? (
        <Dialog
          title="清空全部本地记忆？"
          confirmLabel="确认清空"
          variant="danger"
          confirmDisabled={action.busy}
          onCancel={() => {
            if (!action.busy) setConfirmReset(false);
          }}
          onConfirm={() =>
            void action.run(props.onResetMemories, '本地记忆已清空。').then((ok) => {
              if (ok) setConfirmReset(false);
            })
          }
        >
          <p>
            这会删除 EvoWork 已提取的全部本地记忆，并关闭项目记忆自动同步。项目里的 AGENTS.md
            和任务历史不会被删除。
          </p>
          <SettingsFeedback feedback={action.feedback?.error ? action.feedback : null} />
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * 账号（11 §5.5）。
 *
 * 登录走系统浏览器，所以这一页没有密码框。注销要再输密码，只给一个跳 WEB 的入口。
 */
function AccountSection(props: SettingsPageProps) {
  const { access, onLogin, onLogout, onRevokeDevice, onOpenAccountWeb } = props;
  const signedIn = access?.signedIn === true;
  return (
    <section className="ew-settings-section">
      <header className="ew-settings-page-head">
        <h1>账号</h1>
        <p className="ew-settings-note">按需登录，使用托管模型额度。</p>
      </header>
      <SettingsRow
        label={signedIn ? '已登录' : '本机模式'}
        description={
          signedIn
            ? '任务、产物和自动化仍保存在这台电脑上。'
            : '当前为本机模式，无需登录。使用你自己配置的模型。'
        }
      >
        {signedIn ? (
          onLogout ? (
            <PillButton onClick={onLogout}>退出登录</PillButton>
          ) : null
        ) : onLogin ? (
          <PillButton variant="accent" onClick={onLogin}>
            在浏览器中登录
          </PillButton>
        ) : null}
      </SettingsRow>
      <p className="ew-settings-note">
        任务、产物和自动化不随账号切换；退出登录或注销账号都不会删掉它们。登录只用于解锁托管的模型额度。
      </p>
      {signedIn && access?.role === 'admin' ? (
        <SettingsRow label="组织管理" description="你是租户管理员，管理端在浏览器中打开。">
          <PillButton disabled={!onOpenAccountWeb} onClick={() => onOpenAccountWeb?.('/admin')}>
            打开管理端
          </PillButton>
        </SettingsRow>
      ) : null}
      <div className="ew-settings-group">
        <h3>已登录的设备</h3>
        {!signedIn ? (
          <p className="ew-settings-note">登录后可查看与管理设备。</p>
        ) : (access?.devices ?? []).length === 0 ? (
          <p className="ew-settings-note">暂无设备列表，请稍后重新打开此页。</p>
        ) : (
          access?.devices?.map((device) => (
            <SettingsRow
              key={device.id}
              label={device.name}
              description={`${device.platform}${device.revoked ? ' · 已吊销' : ''}`}
            >
              {!device.revoked && onRevokeDevice ? (
                <PillButton onClick={() => onRevokeDevice(device.id)}>吊销</PillButton>
              ) : null}
            </SettingsRow>
          ))
        )}
      </div>
      {signedIn && onOpenAccountWeb ? (
        <div className="ew-settings-danger-zone">
          <SettingsRow label="注销账号" description="在浏览器中完成账号注销。" danger>
            <PillButton variant="danger" onClick={() => onOpenAccountWeb('/account/delete')}>
              在浏览器中注销账号
            </PillButton>
          </SettingsRow>
        </div>
      ) : null}
    </section>
  );
}

function ModelsSection(props: SettingsPageProps) {
  /** `'new'` = 添加；一条 `CustomModelView` = 改那条 */
  const [editing, setEditing] = useState<'new' | CustomModelView | undefined>(undefined);
  const action = useSettingsAction();
  const [removing, setRemoving] = useState<string>();
  const access = props.access;
  if (!access) return <EmptyState title="正在读取模型状态…" hint="" />;

  // 钥匙串正常时不必解释密钥存哪；明文与不可用**必须**说（11 §4.3）
  const secretsDegraded =
    access.secretBackend === 'plaintext-fallback' || access.secretBackend === 'unavailable';

  return (
    <section className="ew-settings-section">
      {/* 钥匙串不可用：**两个选项并列，不替用户选**（11 §4.3） */}
      {access.secretNotice !== undefined ? (
        <div className="ew-settings-fallback">
          <Banner tone="warning">{access.secretNotice}</Banner>
          <div className="ew-settings-actions">
            <PillButton
              disabled={action.busy}
              onClick={() => void action.run(() => props.onSecretFallback(true))}
            >
              以明文文件保存（权限 600）
            </PillButton>
            <PillButton
              disabled={action.busy}
              onClick={() => void action.run(() => props.onSecretFallback(false))}
            >
              不保存，每次启动我自己填
            </PillButton>
          </div>
        </div>
      ) : null}

      {access.catalogUnavailable !== undefined ? (
        <Banner tone="danger">{access.catalogUnavailable}</Banner>
      ) : null}

      <div className="ew-settings-model-directory">
        <div className="ew-settings-model-card-head">
          <div>
            <h3 className="ew-settings-model-card-title">自定义模型</h3>
          </div>
          <PillButton
            variant="accent"
            disabled={!access.allowCustomModels || action.busy}
            disabledReason={access.lockedReason}
            onClick={() => setEditing('new')}
          >
            添加模型
          </PillButton>
        </div>

        {/* 企业锁了自定义模型：**说清是组织策略**，否则用户会去翻一个已经被锁掉的入口 */}
        {access.allowCustomModels ? null : (
          <Banner tone="warning">{access.lockedReason ?? '你所在组织不允许自己添加模型。'}</Banner>
        )}
        {access.customModels.length === 0 ? (
          <p className="ew-settings-model-empty">
            还没有自定义模型。可添加兼容 DeepSeek、Kimi、GLM 或 OpenAI Chat 协议的 endpoint。
          </p>
        ) : (
          <ul className="ew-settings-model-list">
            {access.customModels.map((model) => (
              <li key={model.id} className="ew-settings-model-row">
                <span className="ew-settings-model-icon" aria-hidden="true">
                  {renderIcon('sparkle')}
                </span>
                <div className="ew-settings-model-copy">
                  <div className="ew-settings-model-name">
                    <span className="ew-settings-model-id" title={model.id}>
                      {model.displayName || model.upstreamModel}
                    </span>
                  </div>
                  {/*
                   * 上下文决定内核在哪儿压缩（总纲 D2）。摆在行里，不点开铅笔也看得出哪条是 32K ——
                   * 「经常压缩」的投诉多半就出在那一条上。
                   */}
                  <span className="ew-settings-model-meta">
                    {PROVIDER_LABEL[model.provider] ?? model.provider}
                    {!model.contextFromTable ? ' · 未验证' : ''}
                  </span>
                  {model.maxContextTokens !== undefined ? (
                    <span className="ew-settings-model-meta">
                      上下文 {shortTokens(model.maxContextTokens)}
                      {model.contextFromTable ? ' · 能力表' : ''}
                    </span>
                  ) : null}
                  {/*
                   * 缺密钥是**用户必须知道**的一条：这条模型在下拉里看着正常、
                   * 发出去 401。正常那条不显示第二行，行高与附件一致。
                   */}
                  {model.keySaved ? null : (
                    <span className="ew-settings-model-warn">尚未配置密钥，请编辑后补充。</span>
                  )}
                </div>
                <div className="ew-settings-model-actions">
                  <IconButton
                    label={`修改 ${model.id}`}
                    icon={renderIcon('pencil')}
                    disabled={action.busy}
                    onClick={() => setEditing(model)}
                  />
                  <IconButton
                    label={`检查 ${model.id} 连接`}
                    icon={renderIcon('link')}
                    onClick={() => props.onProbe(model.id)}
                  />
                  <IconButton
                    label={`删除 ${model.id}`}
                    icon={renderIcon('trash')}
                    disabled={action.busy}
                    onClick={() => setRemoving(model.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ew-settings-actions">
        <button
          type="button"
          className="ew-inline-link"
          title={access.modelsFilePath ?? '~/.evowork/models.toml'}
          disabled={!props.onOpenModelsFolder}
          onClick={props.onOpenModelsFolder}
        >
          打开配置目录
        </button>
      </div>
      <SettingsFeedback feedback={editing || removing ? null : action.feedback} />
      {removing ? (
        <Dialog
          title="删除模型？"
          confirmLabel="确认删除"
          variant="danger"
          confirmDisabled={action.busy}
          onCancel={() => {
            if (!action.busy) setRemoving(undefined);
          }}
          onConfirm={() =>
            void action
              .run(() => props.onRemoveCustomModel(removing), '模型已删除。')
              .then((ok) => {
                if (ok) setRemoving(undefined);
              })
          }
        >
          <p>删除模型配置 {removing}，已有任务历史会保留。</p>
          <SettingsFeedback feedback={action.feedback?.error ? action.feedback : null} />
        </Dialog>
      ) : null}
      {/* 明文兜底必须**看起来就是一种降级**（11 §4.3）；存在钥匙串里时不占版面 */}
      {secretsDegraded ? (
        <p className="ew-settings-note">
          密钥存放位置：
          <strong>{BACKEND_LABEL[access.secretBackend] ?? access.secretBackend}</strong>。
        </p>
      ) : null}
      {access.mode === 'local' ? null : (
        <p className="ew-settings-note">
          上游形态：<strong>{MODE_LABEL[access.mode] ?? access.mode}</strong>。
        </p>
      )}

      {props.probeResult !== undefined ? <Banner tone="info">{props.probeResult}</Banner> : null}

      {editing !== undefined ? (
        <CustomModelDialog
          model={editing === 'new' ? undefined : editing}
          busy={action.busy}
          saveError={action.feedback?.error ? action.feedback.text : undefined}
          onCancel={() => {
            if (!action.busy) setEditing(undefined);
          }}
          onAdd={(input) => {
            void action
              .run(() => props.onAddCustomModel(input), '模型已保存。')
              .then((ok) => {
                if (ok) setEditing(undefined);
              });
          }}
          onUpdate={(input) => {
            void action
              .run(() => props.onUpdateCustomModel(input), '模型已保存。')
              .then((ok) => {
                if (ok) setEditing(undefined);
              });
          }}
          onTest={props.onTestCustomModel}
          onOpenDocs={props.onOpenProviderDocs}
          knownContexts={access.knownContexts ?? []}
          contextPolicy={access.contextPolicy}
        />
      ) : null}
    </section>
  );
}

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
  moonshot: 'Kimi（Moonshot）',
  zhipu: '智谱',
  private: '自定义服务',
};

const MODE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  local: '只用这台电脑上配置的模型',
  hosted: '默认模型来自 EvoWork 云端',
  private: '默认模型来自你所在组织的私有网关',
});

/**
 * 「添加模型」/「修改模型」弹窗（11 §4.4 的附件形态）。
 *
 * 五件事按用户填的顺序排：**供应商 → API Key（可当场测）→ 模型名称 → endpoint → 上下文大小**。
 *
 * ## 上下文大小（2026-10-05，原型确认后落地）
 *
 * 它决定内核在哪儿压缩早期对话（总纲 D2）。四条规矩：
 * - 档位 32K / 64K / 128K / 256K / 1M / 自定义，**按十进制存**（128K = 128,000，比厂商常说的
 *   131,072 小）：估小只是早一点压缩，估大了长任务会在压缩之前被上游拒绝，所以宁小勿大。
 * - **能力表认得出的型号锁定为表里的值**：保存时主进程本来就按表覆盖，
 *   让人改了却不生效是静默降级。实测日期留在能力表里，对话框只说大约何时压缩。
 * - 下面一行算出压缩点：min(上限, 90% 上下文)（F46）。三个数都由宿主给（`ContextPolicyView`）。
 * - 自定义的值进不了内核目录（小于下限）时禁用保存并说为什么。
 *
 * ## 三处与附件不同，都是因为我们的模型不是"套餐里选一个"
 *
 * 1. **模型名称是可输入的组合框**，不是纯下拉：点「测试连接」之后，下拉里换成
 *    上游 `GET {baseUrl}/models` 返回的名单。测完点输入框或右侧箭头都能展开；
 *    测之前 chevron 禁用 —— 写死一张过期的表比没有下拉更糟。仍允许手填：有的
 *    endpoint 没有 `/models`。
 * 2. **endpoint 地址只在需要时出现**：三家内置供应商的地址是已知的（与网关同一张表），
 *    「其他 OpenAI 兼容」必须问。改一条已经指向自建代理的模型时那一行也会出现 ——
 *    藏起来就等于在保存时**静默把用户的地址改回官方**。
 * 3. **「查看文档」按供应商跳**（我们没有自己的 endpoint 文档）。URL 白名单在主进程，
 *    这里只递 provider id（11 §6.3 登记的出网路径）。
 *
 * 「测试连接」**不要求先填模型名**：启用条件是供应商 + API Key（「其他」还要有
 * endpoint）。名单就是这一下要拉回来的东西。
 *
 * ## 这里的明文开关不违反 01 §5.35
 *
 * 那一条禁的是**已保存密钥的读回**（`SecretInput` 没有小眼睛，也没有读回路径）。
 * 这个框里的明文是用户此刻正在打的字，本来就在渲染层 —— 开关默认关，只为让人确认
 * 自己粘对了。改模型时留空 = 沿用已存的那把，我们仍然只显示后四位。
 */
function CustomModelDialog({
  model,
  busy = false,
  saveError,
  onCancel,
  onAdd,
  onUpdate,
  onTest,
  onOpenDocs,
  knownContexts,
  contextPolicy,
}: {
  /** 缺席 = 添加；有值 = 改这一条 */
  readonly model?: CustomModelView | undefined;
  readonly busy?: boolean | undefined;
  readonly saveError?: string | undefined;
  readonly knownContexts: readonly KnownContextView[];
  readonly contextPolicy?: ContextPolicyView | undefined;
  readonly onCancel: () => void;
  readonly onAdd: (input: CustomModelInput) => void;
  readonly onUpdate: (input: CustomModelUpdateInput) => void;
  readonly onTest?: ((input: CustomModelTestInput) => Promise<ModelProbeResult>) | undefined;
  readonly onOpenDocs?: ((provider: string) => void) | undefined;
}) {
  const [provider, setProvider] = useState<string | undefined>(model?.provider);
  const [apiKey, setApiKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [modelName, setModelName] = useState(model?.upstreamModel ?? '');
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '');
  const [testMessage, setTestMessage] = useState<string | undefined>(undefined);
  /** 点「测试连接」之后上游返回的名单。换供应商 / 密钥 / 地址就作废。 */
  const [fetchedModels, setFetchedModels] = useState<readonly string[]>([]);
  const [testing, setTesting] = useState(false);
  const defaultContext = contextPolicy?.defaultTokens ?? FALLBACK_DEFAULT_CONTEXT;
  /*
   * 改一条来自能力表的模型时不沿用表里的值：用户把它改成表外型号的那一刻，
   * 预选的应当是默认值，而不是上一个型号的 1M。
   */
  const initialContext =
    model?.maxContextTokens !== undefined && model.contextFromTable !== true
      ? model.maxContextTokens
      : defaultContext;
  const [contextChoice, setContextChoice] = useState<string>(
    contextPresetFor(initialContext, defaultContext),
  );
  const [contextCustom, setContextCustom] = useState(
    contextPresetFor(initialContext, defaultContext) === CUSTOM_CONTEXT
      ? String(initialContext)
      : '',
  );

  const trimmedName = modelName.trim();
  const trimmedKey = apiKey.trim();
  const trimmedUrl = baseUrl.trim();
  const keyOnFile = model?.keySaved ?? false;
  /*
   * endpoint 那一行什么时候露出来（见头注释第 2 条）：
   * 「其他」必须问；已经不是官方地址的也要露出来，否则保存会把它改回官方。
   */
  const showEndpoint =
    provider === 'private' ||
    (provider !== undefined && trimmedUrl !== '' && trimmedUrl !== PROVIDER_BASE_URL[provider]);

  const knownContext =
    provider === undefined
      ? undefined
      : knownContexts.find(
          (entry) =>
            entry.provider === provider && entry.upstreamModel === trimmedName.toLowerCase(),
        );
  const minContext = contextPolicy?.minTokens ?? FALLBACK_MIN_CONTEXT;
  const chosenContext =
    contextChoice === CUSTOM_CONTEXT
      ? parseContextTokens(contextCustom, minContext)
      : Number(contextChoice);
  const ready =
    provider !== undefined &&
    trimmedName !== '' &&
    trimmedUrl !== '' &&
    // 改的时候不要求重填密钥（留空 = 沿用已存的那把）
    (trimmedKey !== '' || keyOnFile) &&
    // 认得出的型号按表走，不看这一项；认不出的必须是一个进得了内核目录的数
    (knownContext !== undefined || chosenContext !== undefined);
  // 认得出的型号不发：主进程按表覆盖，发了也只是噪音
  const contextField =
    knownContext === undefined && chosenContext !== undefined
      ? { maxContextTokens: chosenContext }
      : {};
  const hasKey = trimmedKey !== '' || keyOnFile;
  const canTest =
    onTest !== undefined && provider !== undefined && hasKey && trimmedUrl !== '' && !testing;
  const testRefusal =
    onTest === undefined
      ? '这个版本不能测试连接。'
      : provider === undefined
        ? '先选一个供应商。'
        : trimmedUrl === ''
          ? '先填 endpoint 地址。'
          : !hasKey
            ? '先填上 API Key。'
            : testing
              ? '正在拉取上游模型列表…'
              : undefined;

  const docsRefusal =
    onOpenDocs === undefined
      ? '这个版本不能打开外部文档。'
      : provider === undefined
        ? '先选一个供应商。'
        : provider === 'private'
          ? '这是你自己的 endpoint，我们没有它的文档。'
          : undefined;

  return (
    <Dialog
      title={model ? '修改模型' : '添加模型'}
      confirmLabel="保存"
      confirmDisabled={!ready || busy}
      closable
      onCancel={onCancel}
      onConfirm={() => {
        if (!ready) return;
        const id = `${provider}/${trimmedName}`;
        if (model) {
          onUpdate({
            previousId: model.id,
            id,
            displayName: trimmedName,
            provider,
            upstreamModel: trimmedName,
            baseUrl: trimmedUrl,
            // 留空 = 不动已存的那把（协议里就是这个语义）
            ...(trimmedKey !== '' ? { apiKey: trimmedKey } : {}),
            ...contextField,
          });
          return;
        }
        onAdd({
          id,
          displayName: trimmedName,
          provider,
          upstreamModel: trimmedName,
          baseUrl: trimmedUrl,
          apiKey: trimmedKey,
          ...contextField,
        });
      }}
    >
      <fieldset className="ew-settings-dialog-fields" disabled={busy}>
        {saveError ? (
          <p className="ew-settings-feedback" data-error="true" role="alert">
            {saveError}
          </p>
        ) : null}
        <div className="ew-field">
          <div className="ew-field-head">
            <span>供应商（仅支持 OpenAI 兼容协议 API）</span>
            <button
              type="button"
              className="ew-inline-link"
              disabled={docsRefusal !== undefined}
              title={docsRefusal ?? '在系统浏览器里打开这家的 API 文档'}
              onClick={() => {
                if (provider !== undefined) onOpenDocs?.(provider);
              }}
            >
              查看文档
              <span className="ew-inline-link-icon" aria-hidden="true">
                {renderIcon('arrow-up-right')}
              </span>
            </button>
          </div>
          <InlineSelect
            field
            ariaLabel="供应商"
            placeholder="选择供应商"
            value={provider}
            icon={renderIcon('model')}
            options={[
              { id: 'deepseek', label: 'DeepSeek API' },
              { id: 'moonshot', label: 'Kimi（Moonshot）API' },
              { id: 'zhipu', label: 'GLM（智谱）API' },
              { id: 'private', label: '其他 OpenAI 兼容 API' },
            ]}
            onChange={(next) => {
              setProvider(next);
              // 换供应商就换地址：留着上一家的地址是"看着填对了、发过去 404"
              setBaseUrl(PROVIDER_BASE_URL[next] ?? '');
              setTestMessage(undefined);
              setFetchedModels([]);
            }}
          />
        </div>

        <div className="ew-field">
          <span>API Key</span>
          <div className="ew-field-row">
            <span className="ew-field-secret">
              <input
                type={revealKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                aria-label="API Key"
                value={apiKey}
                placeholder={
                  keyOnFile
                    ? `已保存 · ****${model?.keyLast4 ?? '****'}（留空则不改）`
                    : '输入你的 API Key'
                }
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setTestMessage(undefined);
                  setFetchedModels([]);
                }}
              />
              <IconButton
                label={revealKey ? '隐藏 API Key' : '显示 API Key'}
                icon={renderIcon(revealKey ? 'eye' : 'eye-off')}
                onClick={() => setRevealKey((value) => !value)}
              />
            </span>
            <PillButton
              disabled={!canTest}
              disabledReason={testRefusal}
              onClick={() => {
                if (!canTest || provider === undefined || onTest === undefined) return;
                setTesting(true);
                setTestMessage('正在拉取上游模型列表…');
                void onTest({
                  provider,
                  baseUrl: trimmedUrl,
                  ...(trimmedKey !== '' ? { apiKey: trimmedKey } : {}),
                  // 留空时用这条已存模型的密钥 —— 明文只在主进程里出现
                  ...(model ? { modelId: model.id } : {}),
                })
                  .then((result) => {
                    const names = result.models ?? [];
                    setFetchedModels(names);
                    if (modelName.trim() === '' && names.length === 1) {
                      setModelName(names[0] ?? '');
                    }
                    setTestMessage(result.message);
                  })
                  .catch(() => setTestMessage('测试没跑起来。'))
                  .finally(() => setTesting(false));
              }}
            >
              测试连接
            </PillButton>
          </div>
          {/* 结果原样显示：通了、密钥不对、没有 /models 是三件不同的事 */}
          {testMessage !== undefined ? <p className="ew-field-hint">{testMessage}</p> : null}
        </div>

        <div className="ew-field">
          <span>模型名称</span>
          <ModelNameCombo
            value={modelName}
            suggestions={fetchedModels}
            onChange={(next) => {
              setModelName(next);
              setTestMessage(undefined);
            }}
          />
        </div>

        {showEndpoint ? (
          <label className="ew-field">
            <span>endpoint 地址</span>
            <input
              value={baseUrl}
              placeholder="https://example.com/v1"
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setTestMessage(undefined);
                setFetchedModels([]);
              }}
            />
          </label>
        ) : null}

        <ContextSizeField
          known={knownContext}
          choice={contextChoice}
          custom={contextCustom}
          chosen={chosenContext}
          defaultTokens={defaultContext}
          compactCap={contextPolicy?.autoCompactCap}
          onChoice={setContextChoice}
          onCustom={setContextCustom}
        />
      </fieldset>
    </Dialog>
  );
}

/** 「自定义…」那一档的 id（不是一个数） */
const CUSTOM_CONTEXT = 'custom';
/** 宿主没给 `contextPolicy` 时（老版本主进程 / 测试夹具）的兜底，与主进程那三个数相同 */
const FALLBACK_DEFAULT_CONTEXT = 256_000;
const FALLBACK_MIN_CONTEXT = 1_000;
/** 档位按十进制存：估小只是早一点压缩，估大会被上游拒绝（见 `CustomModelDialog` 头注释） */
const CONTEXT_PRESETS: readonly number[] = [32_000, 64_000, 128_000, 256_000, 1_000_000];

function contextPresetFor(tokens: number, defaultTokens: number): string {
  return [...CONTEXT_PRESETS, defaultTokens].includes(tokens) ? String(tokens) : CUSTOM_CONTEXT;
}

/** 「自定义」框里的字：允许千分位与空格；不是整数或小于下限 → undefined */
function parseContextTokens(text: string, min: number): number | undefined {
  const value = Number(text.replace(/[,\s_]/g, ''));
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/** 256000 → 256K，1048576 → 1M，28800 → 28.8K */
function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${String(Math.round(tokens / 100_000) / 10).replace(/\.0$/, '')}M`;
  }
  const k = tokens / 1000;
  return `${String(k >= 100 ? Math.round(k) : Math.round(k * 10) / 10).replace(/\.0$/, '')}K`;
}

/**
 * 「上下文大小」一项（见 `CustomModelDialog` 头注释「上下文大小」）。
 *
 * 认得出的型号用**禁用的** InlineSelect 显示表里的值：禁用原因挂在 title 上（01 §6.3），
 * 不换成一段纯文字 —— 换了，用户会以为这一项消失了，而不是"这里按表走"。
 */
function ContextSizeField({
  known,
  choice,
  custom,
  chosen,
  defaultTokens,
  compactCap,
  onChoice,
  onCustom,
}: {
  readonly known: KnownContextView | undefined;
  readonly choice: string;
  readonly custom: string;
  readonly chosen: number | undefined;
  readonly defaultTokens: number;
  readonly compactCap: number | undefined;
  readonly onChoice: (next: string) => void;
  readonly onCustom: (next: string) => void;
}) {
  // F46：压缩点 = min(上限, 90% 上下文)。上限没给时如实只按 90% 算
  const compactAt = (tokens: number): number =>
    Math.min(compactCap ?? Number.POSITIVE_INFINITY, Math.floor(tokens * 0.9));

  if (known) {
    const value = `${known.maxContextTokens.toLocaleString('en-US')}（${shortTokens(known.maxContextTokens)}）`;
    return (
      <div className="ew-field">
        <span>上下文大小</span>
        <InlineSelect
          field
          ariaLabel="上下文大小"
          placeholder={value}
          value="table"
          options={[{ id: 'table', label: value }]}
          disabled
          disabledReason="这个型号在能力表里，上下文按表里的值。换「其他 OpenAI 兼容」或改模型名就能自己选。"
          onChange={() => undefined}
        />
        <p className="ew-field-hint">
          上下文到约 {shortTokens(compactAt(known.maxContextTokens))} 时自动压缩早期对话。
        </p>
      </div>
    );
  }

  const presets = [...new Set([...CONTEXT_PRESETS, defaultTokens])].sort((a, b) => a - b);
  return (
    <div className="ew-field">
      <span>上下文大小</span>
      <InlineSelect
        field
        ariaLabel="上下文大小"
        placeholder="选择上下文大小"
        value={choice}
        options={[
          ...presets.map((tokens) => ({
            id: String(tokens),
            label: `${shortTokens(tokens)}${tokens === defaultTokens ? '（默认）' : ''}`,
          })),
          { id: CUSTOM_CONTEXT, label: '自定义…' },
        ]}
        onChange={onChoice}
      />
      {choice === CUSTOM_CONTEXT ? (
        <div className="ew-field-row">
          <input
            aria-label="自定义上下文（token）"
            inputMode="numeric"
            spellCheck={false}
            placeholder="例如 200000"
            value={custom}
            onChange={(event) => onCustom(event.target.value)}
          />
          <span className="ew-field-unit">token</span>
        </div>
      ) : null}
      {chosen === undefined ? (
        <p className="ew-field-hint" data-tone="warning">
          填一个整数，单位是 token，例如 200000。
        </p>
      ) : (
        <p className="ew-field-hint">
          上下文到约 {shortTokens(compactAt(chosen))}{' '}
          时自动压缩早期对话。填得比模型实际上限大，长任务会在压缩之前被上游拒绝；拿不准就选小一档。
        </p>
      )}
    </div>
  );
}

/**
 * 模型名称：可输入 + 可从上游 `/models` 名单里挑（见 `CustomModelDialog` 头注释第 1 条）。
 *
 * 还没测过、或上游没返回名单时 chevron **禁用并给原因**（01 §5.19 / §6.3），
 * 而不是给一个点开是空盒子的下拉。测完之后点输入框本身也展开名单 —— 组合框的
 * 可点区域是整行，不是右侧那枚 28×28 的箭头。
 */
function ModelNameCombo({
  value,
  suggestions,
  onChange,
}: {
  readonly value: string;
  readonly suggestions: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const showSuggestions = (): void => {
    if (suggestions.length > 0) setOpen(true);
  };
  return (
    <span
      className="ew-field-combo"
      onClick={(event) => {
        // 箭头自己 toggle；点输入区 / 外壳才展开。冒泡到这里会把「点箭头关闭」抵消掉。
        if ((event.target as HTMLElement).closest('button')) return;
        showSuggestions();
      }}
    >
      <input
        aria-label="模型名称"
        value={value}
        spellCheck={false}
        placeholder="上游真实的模型名"
        onChange={(event) => onChange(event.target.value)}
        onFocus={showSuggestions}
      />
      <IconButton
        label="选择上游返回的模型名"
        icon={renderIcon('chevron-down')}
        disabled={suggestions.length === 0}
        disabledReason="先测试连接，从上游拉取模型名。"
        onClick={() => setOpen((next) => !next)}
      />
      <Popover open={open} onClose={() => setOpen(false)} align="end">
        <Menu
          ariaLabel="上游返回的模型名"
          items={suggestions.map((name) => ({ id: name, label: name }))}
          onSelect={(name) => {
            setOpen(false);
            onChange(name);
          }}
        />
      </Popover>
    </span>
  );
}

/**
 * 内置供应商的 endpoint 地址。
 *
 * **与网关那张表必须一致**（`services/gateway/src/providers/registry.ts` 的
 * `DEFAULT_BASE_URL`）：两处不一致时，设置页测得通、真跑起来 404。
 * 2026-09-16 对齐时改掉了 deepseek 少一个 `/v1` 的那条。
 */
const PROVIDER_BASE_URL: Readonly<Record<string, string>> = Object.freeze({
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
});

/**
 * 用量与预算（Q11 的阶段 1）。
 *
 * **托管额度不在这里** —— 它需要账号（M10b）。摆一个空的额度条会承诺一个不存在的东西
 * （同 Q17 把「升级」换成「清理」的那条判断）。
 */
function UsageSection(
  props: SettingsPageProps & {
    readonly onFormState: (state: SettingsFormState) => void;
    readonly resetRevision: number;
  },
) {
  const prefs = props.preferences;
  const savedBudget = prefs?.taskTokenBudget ?? 0;
  const [budget, setBudget] = useState(String(savedBudget || ''));
  const [customBudget, setCustomBudget] = useState(savedBudget > 0);
  const [invalid, setInvalid] = useState<string>();
  const action = useSettingsAction();
  const revision = useRef(props.resetRevision);
  const initialBudget = useRef(savedBudget);
  const ready = useRef(prefs !== null);
  const dirty = customBudget
    ? budget !== String(savedBudget || '') || savedBudget === 0
    : savedBudget > 0;
  useEffect(() => {
    if (!prefs) return;
    if (
      !ready.current ||
      revision.current !== props.resetRevision ||
      initialBudget.current !== savedBudget
    ) {
      ready.current = true;
      revision.current = props.resetRevision;
      initialBudget.current = savedBudget;
      setBudget(String(savedBudget || ''));
      setCustomBudget(savedBudget > 0);
      setInvalid(undefined);
    }
  }, [savedBudget, props.resetRevision, prefs]);
  useEffect(() => {
    props.onFormState({ dirty, busy: action.busy });
  }, [dirty, action.busy, props.onFormState]);
  useEffect(
    () => () => {
      props.onFormState({ dirty: false, busy: false });
    },
    [props.onFormState],
  );
  if (!prefs) return <EmptyState title="正在读取偏好…" hint="" />;
  const save = () => {
    const value = customBudget ? Number(budget) : 0;
    if (customBudget && (!/^\d+$/.test(budget) || !Number.isSafeInteger(value) || value <= 0)) {
      setInvalid('请输入大于 0 的整数。');
      return;
    }
    setInvalid(undefined);
    void action.run(() => props.onPreferences({ taskTokenBudget: value }));
  };
  return (
    <section className="ew-settings-section">
      <header className="ew-settings-page-head">
        <h1>用量与预算</h1>
        <p className="ew-settings-note">控制任务用量和同时运行的任务数量。</p>
      </header>
      <div className="ew-settings-group">
        <h3>本月托管额度</h3>
        {props.access?.signedIn && props.access.quotaLimit !== undefined ? (
          <>
            <p className="ew-settings-quota">
              {props.access.quotaUsed ?? 0}{' '}
              <span className="ew-settings-note">/ {props.access.quotaLimit} tokens</span>
            </p>
            {props.access.quotaLimit > 0 &&
            (props.access.quotaUsed ?? 0) >= props.access.quotaLimit ? (
              <p className="ew-settings-note">额度已用完，不会自动换成其他模型。</p>
            ) : null}
          </>
        ) : (
          <p className="ew-settings-note">
            托管额度在登录之后显示。自定义模型的调用不上报、不计量。
          </p>
        )}
      </div>
      <div className="ew-settings-group">
        <h3>任务限制</h3>
        <SettingsRow
          label="单任务用量上限"
          description="超出预算时暂停并问你，可追加预算或结束任务。"
        >
          <InlineSelect
            ariaLabel="单任务用量上限"
            placeholder="不限"
            value={customBudget ? 'custom' : 'unlimited'}
            options={[
              { id: 'unlimited', label: '不限' },
              { id: 'custom', label: '自定义' },
            ]}
            disabled={action.busy}
            onChange={(id) => {
              setCustomBudget(id === 'custom');
              setInvalid(undefined);
            }}
          />
        </SettingsRow>
        {customBudget ? (
          <label className="ew-field ew-settings-budget-field">
            <span>用量上限（tokens）</span>
            <input
              value={budget}
              inputMode="numeric"
              disabled={action.busy}
              onChange={(event) => {
                setBudget(event.target.value);
                setInvalid(undefined);
              }}
              placeholder="200000"
            />
          </label>
        ) : null}
        {invalid ? (
          <p role="alert" className="ew-settings-feedback" data-error="true">
            {invalid}
          </p>
        ) : null}
        {dirty ? (
          <div className="ew-settings-form-actions">
            <span className="ew-settings-note" role="status">
              未保存
            </span>
            <PillButton
              disabled={action.busy}
              onClick={() => {
                setBudget(String(savedBudget || ''));
                setCustomBudget(savedBudget > 0);
                setInvalid(undefined);
              }}
            >
              取消
            </PillButton>
            <PillButton variant="accent" disabled={action.busy} onClick={save}>
              {action.busy ? '正在保存…' : '保存预算'}
            </PillButton>
          </div>
        ) : null}
        <p className="ew-settings-note">
          不会自动换成更便宜的模型继续。定时任务的强制预算在自动化中单独设置。
        </p>
        <SettingsRow
          label="最大同时运行任务数"
          description={`这台电脑按内存与核数计算的上限是 ${prefs.concurrencyComputed}，只能往下调。`}
        >
          <InlineSelect
            ariaLabel="并发上限"
            placeholder={String(prefs.concurrencyLimit)}
            value={String(prefs.concurrencyLimit)}
            options={Array.from({ length: prefs.concurrencyComputed }, (_, index) => ({
              id: String(index + 1),
              label: String(index + 1),
            }))}
            disabled={action.busy}
            onChange={(id) =>
              void action.run(() => props.onPreferences({ concurrencyLimit: Number(id) }))
            }
          />
        </SettingsRow>
        <SettingsFeedback feedback={action.feedback} />
      </div>
    </section>
  );
}

/** 安全与权限：策略包状态是 M10c 接上的；档位可视化仍如实说没做。 */
function SecuritySection(props: SettingsPageProps) {
  const { access, computerUse: cu } = props;
  const pack = access?.policyPack;
  const action = useSettingsAction();
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const statusLine =
    pack?.status === 'expired'
      ? (pack.message ?? '安全策略已过期，已切换为只读模式。请连接企业网络以更新。')
      : pack?.status === 'expiring'
        ? (pack.message ?? '安全策略即将过期。请连接企业网络以续期。')
        : pack?.status === 'valid'
          ? '这台电脑正在执行企业签名策略。'
          : '这台电脑没有企业策略包。个人使用时不会锁定你自己的模型密钥。';
  return (
    <section className="ew-settings-section">
      <header className="ew-settings-page-head">
        <h1>安全与权限</h1>
        <p className="ew-settings-note">管理电脑操控与应用访问授权。</p>
      </header>
      {pack?.status === 'expired' || pack?.status === 'expiring' ? (
        <Banner tone={pack.status === 'expired' ? 'danger' : 'warning'}>{statusLine}</Banner>
      ) : null}
      <div className="ew-settings-group">
        <h3>电脑操控</h3>
        <SettingsRow
          label="电脑操控"
          htmlFor="settings-computer-use"
          description={
            <span role="status" aria-label="电脑操控状态">
              {cu?.message ?? '当前版本无法读取电脑操控状态。'}
            </span>
          }
        >
          <input
            id="settings-computer-use"
            type="checkbox"
            className="ew-settings-switch"
            checked={pendingEnabled ?? cu?.enabled ?? false}
            disabled={
              !cu ||
              !props.onComputerUseEnabled ||
              action.busy ||
              ['unsupported', 'unverified', 'component-error', 'enterprise-blocked'].includes(
                cu.state,
              )
            }
            onChange={(event) => {
              const enabled = event.target.checked;
              setPendingEnabled(enabled);
              void action
                .run(() => props.onComputerUseEnabled?.(enabled))
                .finally(() => setPendingEnabled(null));
            }}
          />
        </SettingsRow>
        {cu?.component ? (
          <p className="ew-settings-note">
            组件连接：
            {cu.component === 'connected'
              ? '已连接'
              : cu.component === 'error'
                ? '异常，请修复安装后重新检查'
                : '尚未检查'}
          </p>
        ) : null}
        {cu?.permissions ? (
          <div className="ew-settings-subrows">
            <SettingsRow
              label={`辅助功能：${cu.permissions.accessibility ? '已授权' : '未授权'}`}
              description={!cu.permissions.accessibility ? '授权后可操作应用界面。' : undefined}
            >
              {!cu.permissions.accessibility ? (
                <PillButton
                  disabled={!props.onComputerUseSettings}
                  onClick={() => props.onComputerUseSettings?.('accessibility')}
                >
                  打开辅助功能设置
                </PillButton>
              ) : null}
            </SettingsRow>
            <SettingsRow
              label={`屏幕录制：${cu.permissions.screenRecording === true ? '已授权' : cu.permissions.screenRecording === false ? '未授权（可使用辅助功能模式）' : '状态未知，尚未检查'}`}
            >
              {cu.permissions.screenRecording !== true ? (
                <PillButton
                  disabled={!props.onComputerUseSettings}
                  onClick={() => props.onComputerUseSettings?.('screenRecording')}
                >
                  打开屏幕录制设置
                </PillButton>
              ) : null}
            </SettingsRow>
          </div>
        ) : null}
        <div className="ew-settings-actions">
          {cu && !['unsupported', 'unverified'].includes(cu.state) ? (
            <PillButton
              variant="ghost"
              disabled={action.busy || !props.onComputerUseRefresh}
              onClick={() =>
                void action.run(() => props.onComputerUseRefresh?.(), '组件与权限已重新检查。')
              }
            >
              重新检查组件与权限
            </PillButton>
          ) : null}
          {cu?.enabled ? <PillButton onClick={props.onComputerUseStop}>停止控制</PillButton> : null}
        </div>
        <SettingsFeedback feedback={action.feedback} />
      </div>
      {cu?.persistentAllowed === false ? (
        <p className="ew-settings-note">企业策略禁止持久授权；应用准入仅限当前任务。</p>
      ) : null}
      <div className="ew-settings-group">
        <h3>已授权应用</h3>
        {(cu?.grants ?? []).length === 0 ? (
          <p className="ew-settings-note">暂无应用授权。</p>
        ) : (
          cu?.grants.map((grant) => (
            <SettingsRow
              key={grant.appId}
              label={grant.appId}
              description={grant.allowed ? '允许操作' : '拒绝操作'}
            >
              <PillButton
                disabled={action.busy || !props.onComputerUseRevoke}
                onClick={() =>
                  void action.run(
                    () => props.onComputerUseRevoke?.(grant.appId),
                    '应用授权已撤销。',
                  )
                }
              >
                撤销授权
              </PillButton>
            </SettingsRow>
          ))
        )}
        {cu && cu.grants.length > 0 ? (
          <PillButton
            variant="ghost"
            disabled={action.busy || !props.onComputerUseRevoke}
            onClick={() =>
              void action.run(() => props.onComputerUseRevoke?.(), '已清除全部应用授权。')
            }
          >
            清除所有应用授权
          </PillButton>
        ) : null}
        <p className="ew-settings-note">
          清除应用授权不会删除任务历史。界面文字和必要截图随任务留存；归档不删除。删除本机任务不能撤回模型提供方已经收到的数据。
        </p>
      </div>
      <details className="ew-settings-details">
        <summary>企业策略</summary>
        <p className="ew-settings-note">
          {pack?.status === 'expired' || pack?.status === 'expiring'
            ? '请按页首提示恢复企业策略。'
            : statusLine}
        </p>
      </details>
      <SettingsRow
        label="审批与操作记录"
        description="审批模式可在任务输入框中选择。用量与审计页提供审批记录与被拦下的操作。"
      >
        <PillButton disabled={!props.onOpenAudit} onClick={props.onOpenAudit}>
          查看审计
        </PillButton>
      </SettingsRow>
    </section>
  );
}

function AboutSection(props: SettingsPageProps) {
  // 不为 null 时就是确认框开着：里面是「退出会打断什么」
  const [impact, setImpact] = useState<UpdateQuitImpactView | null>(null);
  const update = props.update ?? null;
  const offer = update?.offer;

  const quit = () => {
    const ask = props.onGetUpdateQuitImpact;
    if (!ask) {
      props.onQuitAndInstall?.();
      return;
    }
    void ask().then((found) => {
      const interrupts =
        found.runningTasks.length > 0 || found.upcoming.length > 0 || found.runtimeInstalling;
      if (interrupts) setImpact(found);
      else props.onQuitAndInstall?.();
    });
  };

  return (
    <section className="ew-settings-section">
      <header className="ew-settings-page-head">
        <h1>关于与更新</h1>
        <p className="ew-settings-note">管理应用版本与办公扩展。</p>
      </header>
      <p className="ew-settings-note">
        {props.appName} <span className="ew-mono">{props.appVersion}</span>
      </p>

      <p className="ew-settings-note">
        文件处理、命令执行和定时任务都在这台电脑上完成，文档解析不会把原始文件传到云上。
        模型调用需要联网，你的提问和相关上下文会发给所选模型服务商；EvoWork 网关不保存这些内容。
      </p>

      <UpdateBlock {...props} update={update} onQuit={quit} />

      {offer &&
      (update?.phase === 'available' ||
        update?.phase === 'downloading' ||
        update?.phase === 'verifying') ? (
        <div className="ew-settings-model-card">
          <div className="ew-settings-model-card-head ew-update-card-head">
            <span className="ew-settings-model-card-title">
              EvoWork <span className="ew-mono">{offer.version}</span> 可以更新
            </span>
            <span className="ew-settings-note">约 {megabytes(offer.sizeBytes)} MB</span>
          </div>
          <div className="ew-update-card-body">
            {offer.notes.length > 0 ? (
              <ul className="ew-update-notes">
                {offer.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            {update.phase === 'available' ? (
              <>
                {update.cancelled ? (
                  <p className="ew-settings-note">已取消下载，下载了一半的文件已删除。</p>
                ) : null}
                <div className="ew-approval-actions">
                  <PillButton variant="accent" onClick={props.onDownloadUpdate}>
                    下载 {offer.version}
                  </PillButton>
                </div>
                <p className="ew-settings-note">
                  下载到「下载」文件夹。下载完成后由你决定什么时候安装，不会自动安装。
                </p>
              </>
            ) : update.phase === 'downloading' ? (
              <>
                <ProgressBar
                  percent={update.percent ?? 0}
                  label={`正在下载 EvoWork ${offer.version}`}
                />
                <div className="ew-approval-actions">
                  <span className="ew-settings-note ew-update-progress">
                    正在下载 · {update.percent ?? 0}% · {megabytes(update.receivedBytes ?? 0)} /{' '}
                    {megabytes(offer.sizeBytes)} MB
                  </span>
                  <PillButton variant="ghost" onClick={props.onCancelUpdateDownload}>
                    取消下载
                  </PillButton>
                </div>
              </>
            ) : (
              <p className="ew-settings-note">正在校验安装包…</p>
            )}
          </div>
        </div>
      ) : null}

      <OfficeRuntimeBlock {...props} />

      <p className="ew-settings-note">
        第三方许可声明随安装包分发（<span className="ew-mono">THIRD_PARTY_NOTICES.md</span>）。
      </p>

      {impact ? (
        <Dialog
          title={`退出并安装 ${offer?.version ?? '新版本'}？`}
          confirmLabel="退出并打开安装包"
          cancelLabel="稍后再说"
          onConfirm={() => {
            setImpact(null);
            props.onQuitAndInstall?.();
          }}
          onCancel={() => setImpact(null)}
        >
          <p>EvoWork 退出时，下面这些会被打断：</p>
          <ul className="ew-update-notes">
            {impact.runningTasks.length > 0 ? (
              <li>
                {impact.runningTasks.length} 个任务正在运行：
                {impact.runningTasks.map((title) => `「${title}」`).join('')}
                。它们会停在当前位置，重新打开后可以接着让它们继续。
              </li>
            ) : null}
            {impact.upcoming.map((item) => (
              <li key={`${item.name}-${String(item.at)}`}>
                定时任务「{item.name}」{clockTime(item.at)} 要执行。{item.whenMissed}
              </li>
            ))}
            {impact.runtimeInstalling ? <li>办公扩展正在安装，退出会中断这次安装。</li> : null}
          </ul>
        </Dialog>
      ) : null}
    </section>
  );
}

/** 检查更新那一行 + 开关 + 结果。不可用时如实说为什么，**不给一个点了没反应的按钮** */
function UpdateBlock(
  props: SettingsPageProps & {
    readonly update: UpdateStatusView | null;
    readonly onQuit: () => void;
  },
) {
  const update = props.update;
  const action = useSettingsAction();
  const [pendingCheck, setPendingCheck] = useState<boolean | null>(null);
  if (!update || update.availability === 'unsupported') {
    return (
      <p className="ew-settings-note">
        {update?.message ?? '这个版本还没接上在线升级，需要手动下载新版本安装。'}
      </p>
    );
  }
  if (update.availability === 'off') {
    return <Banner tone="info">你所在的组织统一分发 EvoWork 的更新，这里不检查更新。</Banner>;
  }
  if (update.availability === 'invalid') {
    return (
      <Banner tone="warning">
        更新源的地址配置不对（EVOWORK_UPDATE_FEED），所以这里不检查更新。请联系你的 IT 管理员。
      </Banner>
    );
  }
  if (update.availability === 'no-keys') {
    return (
      <Banner tone="danger">
        这个版本里缺少更新签名公钥，没法确认更新的来源，所以不检查更新。请到官网手动下载最新版本。
      </Banner>
    );
  }

  const busy =
    update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'verifying';
  const retry = update.error === 'stall' || update.error === 'mismatch' || update.error === 'disk';
  return (
    <>
      <div className="ew-approval-actions">
        <PillButton variant="accent" disabled={busy} onClick={props.onCheckUpdate}>
          {update.phase === 'checking' ? '正在检查…' : '检查更新'}
        </PillButton>
        <span className="ew-settings-note ew-update-inline">
          {update.phase === 'latest'
            ? '已是最新版本。'
            : `上次检查：${lastChecked(update.lastCheckedAt)}`}
        </span>
      </div>
      {props.onUpdateAutoCheck ? (
        <label className="ew-checkbox">
          <input
            type="checkbox"
            checked={pendingCheck ?? update.autoCheck}
            className="ew-settings-switch"
            disabled={action.busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              setPendingCheck(enabled);
              void action
                .run(() => props.onUpdateAutoCheck?.(enabled))
                .finally(() => setPendingCheck(null));
            }}
          />
          <span>
            {update.signedIn ? '自动检查更新' : '未登录时也自动检查更新'}
            （每天最多一次，只下载版本清单，不上传任何东西）
          </span>
        </label>
      ) : null}
      <SettingsFeedback feedback={action.feedback} />
      {update.phase === 'error' && update.message ? (
        <Banner
          tone={
            update.error === 'offline' || update.error === 'stall' || update.error === 'server'
              ? 'warning'
              : 'danger'
          }
          action={
            retry && update.offer ? (
              <PillButton onClick={props.onDownloadUpdate}>重新下载</PillButton>
            ) : (
              <PillButton onClick={props.onCheckUpdate}>
                {update.error === 'bad-signature' ? '再检查一次' : '再试一次'}
              </PillButton>
            )
          }
        >
          {update.message}
        </Banner>
      ) : null}
      {update.phase === 'ready' && update.offer ? (
        <>
          <Banner
            tone="accent"
            action={
              <PillButton variant="accent" onClick={props.onQuit}>
                退出并打开安装包
              </PillButton>
            }
          >
            EvoWork {update.offer.version} 已下载并通过校验，保存在「下载」文件夹。
          </Banner>
          <p className="ew-settings-note">
            现在的安装包还没有 Apple 签名，所以要手动替换：EvoWork 退出后会打开安装包，把 EvoWork
            拖进「应用程序」并选择「替换」，再重新打开。
          </p>
        </>
      ) : null}
    </>
  );
}

/** 办公扩展的版本（A4）。装着但不是这一版要的组件时说清楚，**重新安装仍由用户点**（K6 登记） */
function OfficeRuntimeBlock(props: SettingsPageProps) {
  const runtime = props.runtime;
  if (!runtime) return null;
  const size = runtime.downloadSize !== undefined ? `（${runtime.downloadSize}）` : '';
  let body;
  if (props.runtimeProgress) {
    body = (
      <>
        <ProgressBar percent={props.runtimeProgress.percent} label={props.runtimeProgress.label} />
        <p className="ew-settings-note">{props.runtimeProgress.label}</p>
      </>
    );
  } else if (props.runtimeError !== undefined) {
    body = (
      <Banner
        tone="danger"
        action={
          <PillButton onClick={props.onInstallRuntime}>
            {runtime.bundled ? '重新验证' : '重新安装'}
          </PillButton>
        }
      >
        {props.runtimeError}
      </Banner>
    );
  } else if (runtime.checking) {
    body = (
      <p className="ew-settings-note" role="status">
        正在后台验证办公组件，可以继续使用其他功能…
      </p>
    );
  } else if (!runtime.supported) {
    body = <p className="ew-settings-note">这台电脑的架构没有对应的办公扩展。</p>;
  } else if (!runtime.installed) {
    body = (
      <div className="ew-approval-actions">
        <span className="ew-settings-note ew-update-inline">
          还没有安装。Word / Excel / PPT / PDF 的处理要用它。
        </span>
        <PillButton onClick={props.onInstallRuntime}>安装{size}</PillButton>
      </div>
    );
  } else if (runtime.outdated) {
    body = (
      <Banner
        tone="warning"
        action={<PillButton onClick={props.onInstallRuntime}>重新安装{size}</PillButton>}
      >
        办公扩展已安装，但不是这个版本要求的组件。现在仍然能用；重新安装后，Word / Excel / PPT / PDF
        的处理才会换成新组件。
      </Banner>
    );
  } else {
    body = <p className="ew-settings-note">已安装，与这个版本要求的组件一致。</p>;
  }
  return (
    <>
      <SectionHeader title="办公扩展" />
      {body}
    </>
  );
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

function lastChecked(at: number | undefined): string {
  if (at === undefined) return '从未';
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  return new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 24 小时内的时刻；不是今天的写「明天」 */
function clockTime(at: number): string {
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return new Date(at).toDateString() === new Date().toDateString() ? time : `明天 ${time}`;
}
