/**
 * 设置页（11 §4.4）。两栏，左栏复用 PanelNavItem。
 *
 * 阶段 1（M10a）接通模型接入与密钥库；账号 / 用量 / 数据 / 关于给诚实文案，
 * 不假装已经有登录或托管额度。
 */
import { useMemo, useState } from 'react';

import type { SettingsModelRow, SettingsSectionId, SettingsView } from '../../shared/ipc.js';
import { PanelHeader, PanelNavItem } from '../components/panels.js';
import { InlineSelect } from '../components/menu.js';
import {
  Banner,
  Dialog,
  ItemCard,
  PillButton,
  SecretInput,
  SectionHeader,
} from '../components/primitives.js';

const PROTOCOL_ADAPTERS = ['openai-chat', 'deepseek', 'moonshot', 'zhipu'] as const;

export const SETTINGS_NAV: readonly { readonly id: SettingsSectionId; readonly label: string }[] = [
  { id: 'account', label: '账号' },
  { id: 'models', label: '模型接入' },
  { id: 'usage', label: '用量与预算' },
  { id: 'data', label: '数据管理' },
  { id: 'about', label: '关于与更新' },
];

export const SECRET_STORE_UNAVAILABLE =
  '这台电脑上没有可用的系统密钥库，EvoWork 无法加密保存 API 密钥。' +
  '可以选择：以 600 权限的明文文件保存（仅本机可读，但同机的其他程序能读到），' +
  '或每次启动时手动填入（不保存）。';

export const CREDENTIAL_SOURCE_LABEL: Readonly<Record<string, string>> = {
  byok: '自有密钥',
  hosted: '托管',
  private: '私有',
};

const SLOT_FOR_PROVIDER: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
};

export function slotForModel(model: SettingsModelRow): string {
  if (model.layer === 'custom') return `custom:${model.id}`;
  return SLOT_FOR_PROVIDER[model.provider] ?? `custom:${model.id}`;
}

export interface SettingsProps {
  readonly settings: SettingsView;
  readonly section?: SettingsSectionId | undefined;
  readonly onSection?: ((id: SettingsSectionId) => void) | undefined;
  readonly onSaveKey?: ((slot: string, value: string) => void) | undefined;
  readonly onClearKey?: ((slot: string) => void) | undefined;
  readonly onAddCustom?:
    | ((input: {
        id: string;
        displayName: string;
        upstreamModel: string;
        adapter: string;
        baseUrl: string;
        apiKey: string;
      }) => void)
    | undefined;
  readonly onRemoveCustom?: ((id: string) => void) | undefined;
  readonly onChooseFallback?: ((fallback: 'plaintext' | 'ephemeral') => void) | undefined;
  readonly refusal?: string | undefined;
}

export function Settings(props: SettingsProps) {
  const [section, setSection] = useState<SettingsSectionId>(props.section ?? 'models');
  const active = props.section ?? section;
  const go = (id: SettingsSectionId): void => {
    setSection(id);
    props.onSection?.(id);
  };

  return (
    <div className="ew-settings">
      <nav className="ew-settings-panel" aria-label="设置分类">
        <PanelHeader title="设置" />
        {SETTINGS_NAV.map((item) => (
          <PanelNavItem
            key={item.id}
            label={item.label}
            selected={active === item.id}
            onClick={() => go(item.id)}
          />
        ))}
      </nav>
      <main className="ew-settings-main">
        {props.refusal ? <Banner tone="danger">{props.refusal}</Banner> : null}
        {active === 'account' ? <AccountSection settings={props.settings} /> : null}
        {active === 'models' ? <ModelsSection {...props} /> : null}
        {active === 'usage' ? <UsageSection /> : null}
        {active === 'data' ? <DataSection /> : null}
        {active === 'about' ? <AboutSection settings={props.settings} /> : null}
      </main>
    </div>
  );
}

function AccountSection({ settings }: { readonly settings: SettingsView }) {
  return (
    <div>
      <SectionHeader title="账号" size="large" />
      <p className="ew-settings-copy">当前为本机模式，无需登录</p>
      <p className="ew-settings-hint">任务、产物和自动化保存在这台电脑上，不随账号切换。</p>
      <p className="ew-settings-hint">上游模式：{settings.mode}</p>
    </div>
  );
}

function UsageSection() {
  return (
    <div>
      <SectionHeader title="用量与预算" size="large" />
      <p className="ew-settings-copy">
        单任务预算在发送时于 Composer 里设定。托管额度将在登录后显示。
      </p>
    </div>
  );
}

function DataSection() {
  return (
    <div>
      <SectionHeader title="数据管理" size="large" />
      <p className="ew-settings-copy">任务、产物和自动化保存在这台电脑上。磁盘占用见资料库。</p>
    </div>
  );
}

function AboutSection({ settings }: { readonly settings: SettingsView }) {
  return (
    <div>
      <SectionHeader title="关于" size="large" />
      <p className="ew-settings-copy">
        {settings.appName} {settings.appVersion}
      </p>
      <p className="ew-settings-hint">本机用户：{settings.userName}</p>
    </div>
  );
}

function ModelsSection(props: SettingsProps) {
  const [draftId, setDraftId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftUpstream, setDraftUpstream] = useState('');
  const [draftAdapter, setDraftAdapter] = useState('openai-chat');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [removeId, setRemoveId] = useState<string | undefined>();

  const adapters = useMemo(() => PROTOCOL_ADAPTERS.map((id) => ({ id, label: id })), []);

  return (
    <div>
      <SectionHeader title="模型接入" size="large" />
      {props.settings.secretStore.needsChoice ? (
        <Dialog
          title="无法加密保存 API 密钥"
          confirmLabel="以明文文件保存"
          cancelLabel="每次启动时填入"
          onConfirm={() => props.onChooseFallback?.('plaintext')}
          onCancel={() => props.onChooseFallback?.('ephemeral')}
        >
          {props.settings.secretStoreCopy}
        </Dialog>
      ) : null}

      {props.settings.models.map((model) => (
        <ItemCard
          key={model.id}
          name={model.displayName}
          description={`${model.provider}/${model.upstreamModel} · ${CREDENTIAL_SOURCE_LABEL[model.credentialSource] ?? model.credentialSource}`}
          badges={model.disabled ? [model.disabledReason ?? '已停用'] : model.notices.slice(0, 2)}
          tone={model.disabled ? 'warning' : 'default'}
        />
      ))}

      {props.settings.models.map((model) => {
        if (model.credentialSource === 'hosted') {
          return (
            <p key={`${model.id}-hosted`} className="ew-settings-hint">
              {model.displayName}：由管理员配置
            </p>
          );
        }
        return (
          <SecretInput
            key={`${model.id}-key`}
            label={`${model.displayName} 的 API 密钥`}
            savedLast4={model.savedLast4}
            disabled={model.disabled}
            disabledReason={model.disabledReason}
            onSave={(value) => props.onSaveKey?.(slotForModel(model), value)}
            onClear={() => props.onClearKey?.(slotForModel(model))}
          />
        );
      })}

      {props.settings.allowCustomModels ? (
        <div className="ew-settings-custom">
          <SectionHeader title="添加自定义模型" />
          <p className="ew-settings-hint">
            必须选择协议适配类型。只填地址和密钥的话，网关不知道对面说的是哪家的协议。
          </p>
          <label className="ew-field">
            <span>模型 id</span>
            <input
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              aria-label="模型 id"
            />
          </label>
          <label className="ew-field">
            <span>显示名</span>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label="显示名"
            />
          </label>
          <label className="ew-field">
            <span>上游模型名</span>
            <input
              value={draftUpstream}
              onChange={(e) => setDraftUpstream(e.target.value)}
              aria-label="上游模型名"
            />
          </label>
          <label className="ew-field">
            <span>endpoint</span>
            <input
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              aria-label="endpoint"
            />
          </label>
          <InlineSelect
            ariaLabel="协议适配类型"
            placeholder="选择协议适配类型"
            value={draftAdapter}
            options={adapters}
            onChange={setDraftAdapter}
          />
          <label className="ew-field">
            <span>API 密钥</span>
            <input
              type="password"
              autoComplete="off"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              aria-label="自定义模型密钥"
            />
          </label>
          <PillButton
            variant="accent"
            onClick={() => {
              props.onAddCustom?.({
                id: draftId,
                displayName: draftName,
                upstreamModel: draftUpstream,
                adapter: draftAdapter,
                baseUrl: draftUrl,
                apiKey: draftKey,
              });
              setDraftId('');
              setDraftName('');
              setDraftUpstream('');
              setDraftUrl('');
              setDraftKey('');
            }}
          >
            添加
          </PillButton>
        </div>
      ) : (
        <p className="ew-settings-hint">你所在组织要求登录后使用统一配置的模型。</p>
      )}

      {props.settings.models
        .filter((m) => m.layer === 'custom')
        .map((model) => (
          <PillButton key={`rm-${model.id}`} onClick={() => setRemoveId(model.id)}>
            {`移除 ${model.displayName}`}
          </PillButton>
        ))}

      {removeId ? (
        <Dialog
          title="移除这个自定义模型？"
          confirmLabel="移除"
          variant="danger"
          onCancel={() => setRemoveId(undefined)}
          onConfirm={() => {
            props.onRemoveCustom?.(removeId);
            setRemoveId(undefined);
          }}
        >
          只从本机列表里拿掉，不会删除任何任务。
        </Dialog>
      ) : null}
    </div>
  );
}
