/**
 * 设置页（11 §4.4，M10a）—— 02 §2 路由表里那个 `/settings/*` 的实现。
 *
 * 两栏：左侧分类用 `PanelNavItem`（01 §5.24，**不新建导航组件**），右侧一屏内容。
 *
 * ## 六个分类里只有四个有内容，而另外两个**如实说自己没做**
 *
 * 「安全与权限」（审计 UI 是 M4 的遗留项）与「数据管理」的归档任务都还没有实现。
 * 它们**仍然出现在左栏**，点开是一句说明 —— 与 `UnbuiltPage` 同一条纪律：
 * 一个点了没反应的菜单项与一个坏掉的功能在界面上无法区分。
 *
 * ## 这一页不显示任何密钥
 *
 * `ModelAccessView` 的类型里就没有密钥字段（见 `shared/ipc.ts`），
 * 所以"设置页会不会泄漏密钥"这个问题在类型层面已经回答了。
 * 这一页只需要把**已保存 · 后四位**这件事呈现得让人看懂。
 */
import { useState } from 'react';

import { InlineSelect } from '../components/menu.js';
import { DataTable, PanelNavItem, type Column } from '../components/panels.js';
import {
  Badge,
  Banner,
  Dialog,
  EmptyState,
  PillButton,
  SectionHeader,
  SecretInput,
} from '../components/primitives.js';
import type {
  CustomModelInput,
  ModelAccessView,
  ModelOptionView,
  PreferencesView,
} from '../../shared/ipc.js';

export type SettingsSection = 'account' | 'models' | 'usage' | 'data' | 'security' | 'about';

export const SETTINGS_SECTIONS: readonly {
  readonly id: SettingsSection;
  readonly label: string;
}[] = [
  { id: 'account', label: '账号' },
  { id: 'models', label: '模型接入' },
  { id: 'usage', label: '用量与预算' },
  { id: 'data', label: '数据管理' },
  { id: 'security', label: '安全与权限' },
  { id: 'about', label: '关于与更新' },
];

/** 凭据来源 → 人话（11 §4.2）。**它回答"花谁的钱、数据过谁的境"**，所以要看得懂。 */
export const CREDENTIAL_LABEL: Readonly<Record<string, string>> = Object.freeze({
  byok: '你的密钥',
  hosted: '由管理员配置',
  private: '私有 endpoint',
});

/** 密钥存在哪 → 人话（11 §4.3）。明文兜底必须**看起来就是一种降级**。 */
export const BACKEND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  keychain: '钥匙串（macOS）',
  dpapi: 'Windows 凭据保护（DPAPI）',
  libsecret: '系统密钥环（libsecret）',
  'plaintext-fallback': '明文文件（你选择的兜底方式）',
  unavailable: '未保存 —— 这台电脑上没有可用的系统密钥库',
});

export interface SettingsPageProps {
  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly access: ModelAccessView | null;
  readonly preferences: PreferencesView | null;
  readonly appName: string;
  readonly appVersion: string;
  /** 上一次动作被拒绝的原话。**显示出来**，不吞掉 */
  readonly refusal?: string | undefined;
  readonly probeResult?: string | undefined;
  readonly onSaveProviderKey: (providerId: string, apiKey: string) => void;
  readonly onClearProviderKey: (providerId: string) => void;
  readonly onAddCustomModel: (input: CustomModelInput) => void;
  readonly onRemoveCustomModel: (id: string) => void;
  readonly onSecretFallback: (accept: boolean) => void;
  readonly onProbe: (modelId: string) => void;
  readonly onPreferences: (input: { taskTokenBudget?: number; concurrencyLimit?: number }) => void;
  readonly onLogin?: () => void;
  readonly onLogout?: () => void;
  readonly onRevokeDevice?: (deviceId: string) => void;
  readonly onOpenAccountWeb?: (path: string) => void;
}

export function SettingsPage(props: SettingsPageProps) {
  return (
    <div className="ew-page ew-settings">
      <nav className="ew-settings-nav" aria-label="设置分类">
        {SETTINGS_SECTIONS.map((item) => (
          <PanelNavItem
            key={item.id}
            label={item.label}
            selected={props.section === item.id}
            onClick={() => props.onSection(item.id)}
          />
        ))}
      </nav>
      <div className="ew-settings-body">
        {props.refusal !== undefined ? <Banner tone="danger">{props.refusal}</Banner> : null}
        {props.section === 'account' ? (
          <AccountSection
            access={props.access}
            onLogin={props.onLogin}
            onLogout={props.onLogout}
            onRevokeDevice={props.onRevokeDevice}
            onOpenAccountWeb={props.onOpenAccountWeb}
          />
        ) : null}
        {props.section === 'models' ? <ModelsSection {...props} /> : null}
        {props.section === 'usage' ? <UsageSection {...props} /> : null}
        {props.section === 'data' ? <DataSection /> : null}
        {props.section === 'security' ? <SecuritySection /> : null}
        {props.section === 'about' ? (
          <AboutSection appName={props.appName} appVersion={props.appVersion} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * 账号（11 §5.5）。
 *
 * 登录走系统浏览器，所以这一页没有密码框。注销要再输密码，只给一个跳 WEB 的入口。
 */
function AccountSection({
  access,
  onLogin,
  onLogout,
  onRevokeDevice,
  onOpenAccountWeb,
}: {
  readonly access: ModelAccessView | null;
  readonly onLogin?: (() => void) | undefined;
  readonly onLogout?: (() => void) | undefined;
  readonly onRevokeDevice?: ((deviceId: string) => void) | undefined;
  readonly onOpenAccountWeb?: ((path: string) => void) | undefined;
}) {
  const signedIn = access?.signedIn === true;
  return (
    <section className="ew-settings-section">
      <SectionHeader title="账号" />
      {signedIn ? (
        <>
          <p className="ew-settings-note">
            已登录。任务、产物和自动化仍然保存在<strong>这台电脑上</strong>
            ，退出登录或注销账号都不会删掉它们。
          </p>
          {access?.role === 'admin' ? (
            <p className="ew-settings-note">
              你是这个租户的管理员。管理端在浏览器里，客户端没有管理界面。
              {onOpenAccountWeb ? (
                <>
                  {' '}
                  <PillButton onClick={() => onOpenAccountWeb('/admin')}>打开管理端</PillButton>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="ew-settings-actions">
            {onLogout ? <PillButton onClick={onLogout}>退出登录</PillButton> : null}
            {onOpenAccountWeb ? (
              <PillButton onClick={() => onOpenAccountWeb('/account/delete')}>
                在浏览器中注销账号
              </PillButton>
            ) : null}
          </div>
          <SectionHeader title="已登录的设备" />
          {(access.devices ?? []).length === 0 ? (
            <p className="ew-settings-note">还没有设备列表。打开这一页时会从账号服务拉取。</p>
          ) : (
            <ul className="ew-settings-note">
              {access.devices?.map((device) => (
                <li key={device.id}>
                  {device.name} · {device.platform}
                  {device.revoked ? '（已吊销）' : null}
                  {!device.revoked && onRevokeDevice ? (
                    <>
                      {' '}
                      <PillButton onClick={() => onRevokeDevice(device.id)}>吊销</PillButton>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <Banner tone="info">
            当前为本机模式，无需登录。你自己的模型密钥只保存在这台电脑上。
          </Banner>
          <p className="ew-settings-note">
            任务、产物和自动化保存在<strong>这台电脑上</strong>，不随账号切换。
            登录只用于解锁托管的模型额度。
          </p>
          {onLogin ? <PillButton onClick={onLogin}>在浏览器中登录</PillButton> : null}
        </>
      )}
    </section>
  );
}

function ModelsSection(props: SettingsPageProps) {
  const [adding, setAdding] = useState(false);
  const access = props.access;
  if (!access) return <EmptyState title="正在读取模型接入状态…" hint="" />;

  return (
    <section className="ew-settings-section">
      <SectionHeader title="模型接入" />

      {/* 钥匙串不可用：**两个选项并列，不替用户选**（11 §4.3） */}
      {access.secretNotice !== undefined ? (
        <div className="ew-settings-fallback">
          <Banner tone="warning">{access.secretNotice}</Banner>
          <div className="ew-settings-actions">
            <PillButton onClick={() => props.onSecretFallback(true)}>
              以明文文件保存（权限 600）
            </PillButton>
            <PillButton onClick={() => props.onSecretFallback(false)}>
              不保存，每次启动我自己填
            </PillButton>
          </div>
        </div>
      ) : null}

      {access.catalogUnavailable !== undefined ? (
        <Banner tone="danger">{access.catalogUnavailable}</Banner>
      ) : null}

      <p className="ew-settings-note">
        密钥存放位置：<strong>{BACKEND_LABEL[access.secretBackend] ?? access.secretBackend}</strong>
        。上游形态：<strong>{MODE_LABEL[access.mode] ?? access.mode}</strong>。
      </p>

      <SectionHeader title="内置厂商" />
      {access.providers.map((provider) => (
        <SecretInput
          key={provider.id}
          label={`${provider.label} API 密钥`}
          saved={provider.saved}
          last4={provider.last4}
          disabled={access.secretBackend === 'unavailable'}
          onSave={(value) => props.onSaveProviderKey(provider.id, value)}
          onClear={provider.saved ? () => props.onClearProviderKey(provider.id) : undefined}
        />
      ))}

      <SectionHeader title="现在可以选的模型" />
      {access.signedIn ? null : (
        <p className="ew-settings-note">
          登录后可使用管理员配置的默认模型。未登录时不会向我们的云请求目录。
        </p>
      )}
      {access.models.length === 0 ? (
        <EmptyState
          title="还没有可用的模型"
          hint="填入上面任意一家的密钥，或添加一个自定义模型。"
        />
      ) : (
        <DataTable
          rows={access.models}
          columns={modelColumns(props.onProbe)}
          ariaLabel="可用模型"
        />
      )}
      {props.probeResult !== undefined ? <Banner tone="info">{props.probeResult}</Banner> : null}

      <SectionHeader
        title="自定义模型"
        actions={
          <PillButton
            variant="accent"
            disabled={!access.allowCustomModels}
            disabledReason={access.lockedReason}
            onClick={() => setAdding(true)}
          >
            添加模型
          </PillButton>
        }
      />
      {/* 企业锁了自定义模型：**说清是组织策略**，否则用户会去翻一个已经被锁掉的入口 */}
      {access.allowCustomModels ? null : (
        <Banner tone="warning">{access.lockedReason ?? '你所在组织不允许自己添加模型。'}</Banner>
      )}
      {access.customModels.length === 0 ? (
        <p className="ew-settings-note">
          还没有自定义模型。任何兼容 DeepSeek / Kimi / GLM / OpenAI 协议的 endpoint 都可以加进来，
          密钥同样只保存在这台电脑上。
        </p>
      ) : (
        <ul className="ew-settings-list">
          {access.customModels.map((model) => (
            <li key={model.id} className="ew-settings-list-row">
              <span className="ew-mono">{model.id}</span>
              <span className="ew-settings-note">
                {model.provider} · {model.baseUrl}
                {model.keySaved ? ` · 密钥已保存 ****${model.keyLast4 ?? '****'}` : ' · 缺密钥'}
              </span>
              <PillButton onClick={() => props.onRemoveCustomModel(model.id)}>删除</PillButton>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddCustomModelDialog
          onCancel={() => setAdding(false)}
          onConfirm={(input) => {
            props.onAddCustomModel(input);
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}

const MODE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  local: '只用这台电脑上配置的模型',
  hosted: '默认模型来自 EvoWork 云端',
  private: '默认模型来自你所在组织的私有网关',
});

/**
 * 模型表的列。
 *
 * **被停用的那一行仍然在表里**（11 §4.1），显示成划除 + 原因；
 * 隐藏它会让用户去问客服"我明明配了密钥为什么没有"。
 */
function modelColumns(onProbe: (id: string) => void): readonly Column<ModelOptionView>[] {
  return [
    {
      id: 'label',
      header: '模型',
      render: (row) => (
        <span className="ew-mono" data-denied={row.denied ? 'true' : undefined}>
          {row.label}
        </span>
      ),
    },
    {
      id: 'credential',
      header: '凭据',
      render: (row) => (
        <Badge variant={row.credentialSource === 'byok' ? 'neutral' : 'info'}>
          {CREDENTIAL_LABEL[row.credentialSource] ?? row.credentialSource}
        </Badge>
      ),
    },
    {
      id: 'verified',
      header: '能力实测',
      // 自定义模型的能力位是用户手填的声明 —— **不能显示成我们验过了**
      render: (row) => (row.verified ? '已实测' : '未实测（手填）'),
    },
    {
      id: 'state',
      header: '状态',
      render: (row) =>
        row.denied !== undefined ? (
          <Badge variant="danger">{row.denied}</Badge>
        ) : (
          <PillButton variant="ghost" onClick={() => onProbe(row.id)}>
            检查
          </PillButton>
        ),
    },
  ];
}

/** 添加自定义模型。**协议适配类型必选** —— endpoint 说哪种方言猜不出来（11 §4.1）。 */
function AddCustomModelDialog({
  onCancel,
  onConfirm,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: (input: CustomModelInput) => void;
}) {
  const [id, setId] = useState('');
  const [upstream, setUpstream] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [apiKey, setApiKey] = useState('');

  const ready =
    id.trim() !== '' &&
    upstream.trim() !== '' &&
    baseUrl.trim() !== '' &&
    provider !== undefined &&
    apiKey.trim() !== '';

  return (
    <Dialog
      title="添加自定义模型"
      confirmLabel="添加"
      confirmDisabled={!ready}
      onCancel={onCancel}
      onConfirm={() =>
        onConfirm({
          id: id.trim(),
          provider: provider ?? '',
          upstreamModel: upstream.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
        })
      }
    >
      <label className="ew-field">
        <span>在 EvoWork 里的 id（任务里用它指定模型）</span>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="my/llm" />
      </label>
      <label className="ew-field">
        <span>上游真实模型名</span>
        <input
          value={upstream}
          onChange={(e) => setUpstream(e.target.value)}
          placeholder="qwen3-max"
        />
      </label>
      <label className="ew-field">
        <span>endpoint 地址</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://example.com/v1"
        />
      </label>
      <div className="ew-field">
        <span>协议适配类型（必选）</span>
        <InlineSelect
          ariaLabel="协议适配类型"
          placeholder="选一个"
          value={provider}
          options={[
            { id: 'deepseek', label: 'DeepSeek 兼容' },
            { id: 'moonshot', label: 'Kimi（Moonshot）兼容' },
            { id: 'zhipu', label: 'GLM（智谱）兼容' },
            { id: 'private', label: 'OpenAI Chat 兼容 / 私有' },
          ]}
          onChange={setProvider}
        />
        <p className="ew-field-hint">
          不同 endpoint 的流式与工具调用格式不一样，这个猜不出来 —— 选错了的表现是回复是空的。
        </p>
      </div>
      <label className="ew-field">
        <span>API 密钥</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <p className="ew-field-hint">
        能力徽标（推理 / 读图 / 并行工具）默认按<strong>最保守</strong>的一档记，
        因为我们没有实测过这个 endpoint。填错的代价由你承担，所以不替你乐观。
      </p>
    </Dialog>
  );
}

/**
 * 用量与预算（Q11 的阶段 1）。
 *
 * **托管额度不在这里** —— 它需要账号（M10b）。摆一个空的额度条会承诺一个不存在的东西
 * （同 Q17 把「升级」换成「清理」的那条判断）。
 */
function UsageSection(props: SettingsPageProps) {
  const prefs = props.preferences;
  const [budget, setBudget] = useState<string>(
    prefs?.taskTokenBudget !== undefined ? String(prefs.taskTokenBudget) : '',
  );
  if (!prefs) return <EmptyState title="正在读取偏好…" hint="" />;

  return (
    <section className="ew-settings-section">
      <SectionHeader title="用量与预算" />
      {props.access?.signedIn && props.access.quotaLimit !== undefined ? (
        <p className="ew-settings-note">
          本月托管额度：已用 {props.access.quotaUsed ?? 0} / {props.access.quotaLimit} tokens。
          {props.access.quotaLimit > 0 && (props.access.quotaUsed ?? 0) >= props.access.quotaLimit
            ? '额度已用完，不会自动换成其他模型。'
            : null}
        </p>
      ) : (
        <p className="ew-settings-note">托管额度在登录之后显示。自定义模型的调用不上报、不计量。</p>
      )}
      <label className="ew-field">
        <span>单个任务的 token 硬预算（留空 = 不限）</span>
        <input
          value={budget}
          inputMode="numeric"
          onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => props.onPreferences({ taskTokenBudget: Number(budget || '0') })}
          placeholder="200000"
        />
      </label>
      <p className="ew-settings-note">
        超出预算时任务<strong>暂停并问你</strong>，只有「追加预算」和「结束任务」两个选择 ——
        不会自动换成更便宜的模型继续（那会让你拿到质量更差的产物却不知道为什么）。
        定时任务另有强制预算，在自动化里单独设。
      </p>

      <div className="ew-field">
        <span>同时最多跑几个任务</span>
        <InlineSelect
          ariaLabel="并发上限"
          placeholder={String(prefs.concurrencyLimit)}
          value={String(prefs.concurrencyLimit)}
          options={Array.from({ length: prefs.concurrencyComputed }, (_, index) => ({
            id: String(index + 1),
            label: String(index + 1),
          }))}
          onChange={(id) => props.onPreferences({ concurrencyLimit: Number(id) })}
        />
        <p className="ew-field-hint">
          这台电脑按内存与核数算出来的上限是 {prefs.concurrencyComputed} ——
          <strong>只能往下调</strong>：机器就是资源上限，调高只会让它卡住。
        </p>
      </div>
    </section>
  );
}

/** 数据管理：**归档任务的 UI 还没做**，如实说，并指向已经有的那一半（资料库的占用条）。 */
function DataSection() {
  return (
    <section className="ew-settings-section">
      <SectionHeader title="数据管理" />
      <p className="ew-settings-note">
        任务、产物索引与解析缓存都在这台电脑的 <span className="ew-mono">~/.evowork/</span> 下。
        本机磁盘占用与「清理」在<strong>资料库</strong>页底部（不做云盘，所以这里没有「升级」）。
      </p>
      <EmptyState
        title="归档任务的管理界面还没做好"
        hint="归档能力本身可用（任务行的操作菜单里），只是还没有这一页的批量视图。"
      />
    </section>
  );
}

/** 安全与权限：M4 的遗留项。**说清是没做，不是坏了**。 */
function SecuritySection() {
  return (
    <section className="ew-settings-section">
      <SectionHeader title="安全与权限" />
      <p className="ew-settings-note">
        审批记录与被拦下的操作现在在<strong>用量与审计</strong>页里看（侧边栏「更多」进）。
      </p>
      <EmptyState
        title="权限档位的可视化设置还没做好"
        hint="档位本身可用：在首页 Composer 底部选，或在引导第③步设默认值。"
      />
    </section>
  );
}

function AboutSection({
  appName,
  appVersion,
}: {
  readonly appName: string;
  readonly appVersion: string;
}) {
  return (
    <section className="ew-settings-section">
      <SectionHeader title="关于与更新" />
      <p className="ew-settings-note">
        {appName} <span className="ew-mono">{appVersion}</span>
      </p>
      <p className="ew-settings-note">
        第三方许可声明随安装包分发（<span className="ew-mono">THIRD_PARTY_NOTICES.md</span>）。
        自动更新还没接上 —— 现在需要手动下载新版本安装。
      </p>
    </section>
  );
}
