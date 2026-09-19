/**
 * 设置页（11 §4.4，M10a）—— 02 §2 路由表里那个 `/settings/*` 的实现。
 *
 * 两栏：左侧分类用 `PanelNavItem`（01 §5.24，**不新建导航组件**），右侧一屏内容。
 *
 * ## 六个分类里只有四个有内容，而另外两个**如实说自己没做**
 *
 * 「安全与权限」现在展示策略包状态（M10c / R11）。权限档位的可视化编辑
 * 仍未做（10 §7 的本机安全能力页），空态说清，不装成坏了。
 *
 * ## 这一页不显示任何密钥
 *
 * `ModelAccessView` 的类型里就没有密钥字段（见 `shared/ipc.ts`），
 * 所以"设置页会不会泄漏密钥"这个问题在类型层面已经回答了。
 * 这一页只需要把**已保存 · 后四位**这件事呈现得让人看懂。
 */
import { useState } from 'react';

import { renderIcon } from '../components/icons.js';
import { InlineSelect, Menu, Popover } from '../components/menu.js';
import { DataTable, PanelNavItem, type Column } from '../components/panels.js';
import {
  Badge,
  Banner,
  Dialog,
  EmptyState,
  IconButton,
  PillButton,
  SectionHeader,
  SecretInput,
} from '../components/primitives.js';
import type {
  CustomModelInput,
  CustomModelTestInput,
  CustomModelUpdateInput,
  CustomModelView,
  ModelAccessView,
  ModelOptionView,
  ModelProbeResult,
  PreferencesView,
} from '../../shared/ipc.js';

export type SettingsSection = 'account' | 'models' | 'usage' | 'data' | 'security' | 'about';

export const SETTINGS_SECTIONS: readonly {
  readonly id: SettingsSection;
  readonly label: string;
}[] = [
  { id: 'account', label: '账号' },
  { id: 'models', label: '模型' },
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
  /** 改一条已存在的（行内铅笔）。留空的密钥字段 = 不动已存的那把 */
  readonly onUpdateCustomModel: (input: CustomModelUpdateInput) => void;
  readonly onRemoveCustomModel: (id: string) => void;
  /**
   * 保存之前的「测试连接」。**返回 Promise 而不是走统一的 `onModelAccessAction`**：
   * 它不改任何本机状态，结果要回到弹窗里那一行，而不是页顶的横幅。
   */
  readonly onTestCustomModel: (input: CustomModelTestInput) => Promise<ModelProbeResult>;
  /** 在访达里打开 `models.toml` 所在目录。没注入 `shell` 时缺席，链接**禁用** */
  readonly onOpenModelsFolder?: (() => void) | undefined;
  /** 「查看文档」。渲染层只递 provider id，URL 白名单在主进程（11 §6.3） */
  readonly onOpenProviderDocs?: ((provider: string) => void) | undefined;
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
        {props.section === 'security' ? <SecuritySection access={props.access} /> : null}
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

/**
 * 「模型」一屏（11 §4.4）。
 *
 * ## 常态下这一页**只有那张自定义模型卡**
 *
 * 2026-09-16 按设计附件重做：主区就是「自定义模型」卡 —— 说明文字里带上真实落盘路径、
 * 右上角「添加模型」、每行三个动作（改 · 测连通 · 删）。其余几段
 * （内置厂商密钥 · 四层合并结果 · 密钥存放位置 · 上游形态）**只在它们有话要说时出现**：
 *
 * | 段 | 什么时候出现 | 为什么不能一直摆着 |
 * |---|---|---|
 * | 内置厂商密钥 | 那一家**已经存过**密钥（引导里填的） | 一直摆着就是三个空框，而新加模型现在走「添加模型」这一个门 |
 * | 合并结果表 | 有卡片之外的模型（托管默认模型 / 被策略停用的） | 全是自定义模型时它逐行重复卡片 |
 * | 密钥存放位置 | 钥匙串**不可用或已降级成明文** | 正常存在钥匙串里时这一行没有信息量 |
 * | 上游形态 | `mode ≠ local`（云端或私有网关） | 本机模式是常态，说一遍等于没说 |
 *
 * **它们是条件显示，不是删掉**：明文兜底、被企业停用的模型、托管默认模型这三件事
 * 一旦发生就必须看得见（11 §4.1 / §4.3 的「不隐藏」）。删掉的只有"没有内容时的占位"。
 */
function ModelsSection(props: SettingsPageProps) {
  /** `'new'` = 添加；一条 `CustomModelView` = 改那条 */
  const [editing, setEditing] = useState<'new' | CustomModelView | undefined>(undefined);
  const access = props.access;
  if (!access) return <EmptyState title="正在读取模型状态…" hint="" />;

  const customIds = new Set(access.customModels.map((model) => model.id));
  // 卡片之外还有哪些模型：托管默认模型、配了密钥的内置三家、被策略停用的
  const otherModels = access.models.filter((model) => !customIds.has(model.id));
  const savedProviders = access.providers.filter((provider) => provider.saved);
  // 钥匙串正常时不必解释密钥存哪；明文与不可用**必须**说（11 §4.3）
  const secretsDegraded =
    access.secretBackend === 'plaintext-fallback' || access.secretBackend === 'unavailable';

  return (
    <section className="ew-settings-section">
      <SectionHeader title="模型" />

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

      <div className="ew-settings-model-card">
        <div className="ew-settings-model-card-head">
          <div>
            <h3 className="ew-settings-model-card-title">自定义模型</h3>
            <p className="ew-settings-note">
              模型添加后会自动写入到本地{' '}
              {/*
               * 路径由宿主给（`modelsFilePath`），不在这里拼死：`EVOWORK_HOME` 可以被
               * 覆盖，而这一行说的是"你加的东西写到哪去了"—— 写错了比不写更糟。
               */}
              <button
                type="button"
                className="ew-inline-link"
                title="在访达 / 资源管理器里打开它所在的目录"
                onClick={props.onOpenModelsFolder}
                disabled={props.onOpenModelsFolder === undefined}
              >
                {access.modelsFilePath ?? '~/.evowork/models.toml'}
              </button>{' '}
              文件中
            </p>
          </div>
          <PillButton
            disabled={!access.allowCustomModels}
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
                    <span className="ew-settings-model-id">{model.id}</span>
                    {/*
                     * 「自定义」在这里同时是一句免责声明：这条 endpoint 的能力位是用户
                     * 自己填的，我们没实测过（11 §4.1 的 `verified`）。
                     */}
                    <span className="ew-settings-model-kind">自定义</span>
                  </div>
                  {/*
                   * 缺密钥是**用户必须知道**的一条：这条模型在下拉里看着正常、
                   * 发出去 401。正常那条不显示第二行，行高与附件一致。
                   */}
                  {model.keySaved ? null : (
                    <span className="ew-settings-model-warn">
                      这条还没有密钥，发出去会被上游拒绝 —— 点铅笔补一把。
                    </span>
                  )}
                </div>
                <div className="ew-settings-model-actions">
                  <IconButton
                    label={`修改 ${model.id}`}
                    icon={renderIcon('pencil')}
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
                    onClick={() => props.onRemoveCustomModel(model.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

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

      {/*
       * 内置三家里**已经存过密钥**的那几把（引导第 ④ 步填的）。
       *
       * 没存过的不列：新加模型现在走「添加模型」这一个门（附件的形态），
       * 三个常年空着的框只会让人以为那才是正路。已存的必须留一个入口 ——
       * 否则引导里填错一把 key 之后，用户在界面上没有任何地方能改它。
       */}
      {savedProviders.length === 0 ? null : (
        <>
          <SectionHeader title="内置厂商密钥" />
          <p className="ew-settings-note">这些是引导时填过的。要再加一家，用上面的「添加模型」。</p>
          {savedProviders.map((provider) => (
            <SecretInput
              key={provider.id}
              label={`${provider.label} API 密钥`}
              saved={provider.saved}
              last4={provider.last4}
              disabled={access.secretBackend === 'unavailable'}
              onSave={(value) => props.onSaveProviderKey(provider.id, value)}
              onClear={() => props.onClearProviderKey(provider.id)}
            />
          ))}
        </>
      )}

      {/*
       * 卡片之外的模型（托管默认模型 · 内置三家 · 被策略停用的）。
       * **被停用的那一行要留在表里**（11 §4.1）：消失的东西无法被排查。
       */}
      {otherModels.length === 0 ? null : (
        <>
          <SectionHeader title="其他可用模型" />
          {access.signedIn ? null : (
            <p className="ew-settings-note">
              登录后可使用管理员配置的默认模型。未登录时不会向我们的云请求目录。
            </p>
          )}
          <DataTable
            rows={otherModels}
            columns={modelColumns(props.onProbe)}
            ariaLabel="可用模型"
          />
        </>
      )}
      {props.probeResult !== undefined ? <Banner tone="info">{props.probeResult}</Banner> : null}

      {editing !== undefined ? (
        <CustomModelDialog
          model={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(undefined)}
          onAdd={(input) => {
            props.onAddCustomModel(input);
            setEditing(undefined);
          }}
          onUpdate={(input) => {
            props.onUpdateCustomModel(input);
            setEditing(undefined);
          }}
          onTest={props.onTestCustomModel}
          onOpenDocs={props.onOpenProviderDocs}
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

/**
 * 「添加模型」/「修改模型」弹窗（11 §4.4 的附件形态）。
 *
 * 四件事按用户填的顺序排：**供应商 → API Key（可当场测）→ 模型名称 → endpoint**。
 *
 * ## 三处与附件不同，都是因为我们的模型不是"套餐里选一个"
 *
 * 1. **模型名称是可输入的组合框**，不是纯下拉：点「测试连接」之后，下拉里换成
 *    上游 `GET {baseUrl}/models` 返回的名单。测之前 chevron 禁用 —— 写死一张
 *    过期的表比没有下拉更糟。仍允许手填：有的 endpoint 没有 `/models`。
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
  onCancel,
  onAdd,
  onUpdate,
  onTest,
  onOpenDocs,
}: {
  /** 缺席 = 添加；有值 = 改这一条 */
  readonly model?: CustomModelView | undefined;
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

  const ready =
    provider !== undefined &&
    trimmedName !== '' &&
    trimmedUrl !== '' &&
    // 改的时候不要求重填密钥（留空 = 沿用已存的那把）
    (trimmedKey !== '' || keyOnFile);
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
      confirmDisabled={!ready}
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
        });
      }}
    >
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
    </Dialog>
  );
}

/**
 * 模型名称：可输入 + 可从上游 `/models` 名单里挑（见 `CustomModelDialog` 头注释第 1 条）。
 *
 * 还没测过、或上游没返回名单时 chevron **禁用并给原因**（01 §5.19 / §6.3），
 * 而不是给一个点开是空盒子的下拉。
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
  return (
    <span className="ew-field-combo">
      <input
        aria-label="模型名称"
        value={value}
        spellCheck={false}
        placeholder="上游真实的模型名"
        onChange={(event) => onChange(event.target.value)}
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

/** 安全与权限：策略包状态是 M10c 接上的；档位可视化仍如实说没做。 */
function SecuritySection({ access }: { readonly access: ModelAccessView | null }) {
  const pack = access?.policyPack;
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
      <SectionHeader title="安全与权限" />
      <p className="ew-settings-note">
        审批记录与被拦下的操作现在在<strong>用量与审计</strong>页里看（侧边栏「更多」进）。
      </p>
      {pack?.status === 'expired' || pack?.status === 'expiring' ? (
        <Banner tone={pack.status === 'expired' ? 'danger' : 'warning'}>{statusLine}</Banner>
      ) : (
        <p className="ew-settings-note">{statusLine}</p>
      )}
      <EmptyState
        title="权限档位的可视化设置还没做好"
        hint="档位本身可用：在首页 Composer 底部选，或在引导第③步设默认值。企业禁用的档会留在列表里并给出原因。"
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
