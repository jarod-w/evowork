/**
 * 设置页（11 §4.4）与 01 §5.35 SecretInput。
 *
 * 这一屏的断言都是**后果**而不是布局：
 *   · SecretInput 已保存态不能显示成一个空输入框（组件本身仍保留，设置页暂时不用）；
 *   · 引导填过密钥时这一页仍然只有那张自定义模型卡（11 §4.4.1）；
 *   · 钥匙串不可用时两个选项并列（不替用户选）；
 *   · 并发上限只能往下调（机器就是资源上限）。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SecretInput } from '../src/renderer/components/primitives.js';
import { SettingsPage, type SettingsPageProps } from '../src/renderer/views/settings.js';
import type {
  CustomModelView,
  MemorySettingsView,
  ModelAccessView,
  ModelOptionView,
  UpdateQuitImpactView,
  UpdateStatusView,
} from '../src/shared/ipc.js';

function model(over: Partial<ModelOptionView> = {}): ModelOptionView {
  return {
    id: 'evowork/deepseek-v4-flash',
    label: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek',
    capabilities: [],
    notices: [],
    credentialSource: 'byok',
    verified: true,
    ...over,
  };
}

/** 一条本机自定义模型（第③层）。附件里那一行长这样 */
function custom(over: Partial<CustomModelView> = {}): CustomModelView {
  return {
    id: 'deepseek/deepseek-v4-flash-0731',
    displayName: 'deepseek-v4-flash-0731',
    provider: 'deepseek',
    upstreamModel: 'deepseek-v4-flash-0731',
    baseUrl: 'https://api.deepseek.com/v1',
    keySaved: true,
    keyLast4: '3f9a',
    ...over,
  };
}

const ACCESS: ModelAccessView = {
  mode: 'local',
  secretBackend: 'keychain',
  providers: [
    { id: 'deepseek', label: 'DeepSeek', saved: true, last4: '3f9a' },
    { id: 'moonshot', label: 'Kimi（Moonshot）', saved: false },
  ],
  customModels: [],
  models: [model()],
  // 宿主给的真实路径。渲染层不拼死它 —— `EVOWORK_HOME` 可以被覆盖
  modelsFilePath: '~/somewhere/models.toml',
  allowCustomModels: true,
  signedIn: false,
};

const MEMORY: MemorySettingsView = {
  enabled: true,
  version: 'v2',
  useMemories: true,
  generateMemories: true,
  disableOnExternalContext: true,
  statusSupported: true,
  resetSupported: true,
  taskModeSupported: true,
  consolidatedThreads: 4,
  ready: true,
};

function page(over: Partial<SettingsPageProps> = {}) {
  const props: SettingsPageProps = {
    section: 'models',
    onSection: vi.fn(),
    access: ACCESS,
    preferences: { concurrencyComputed: 3, concurrencyLimit: 3 },
    memory: MEMORY,
    appName: 'EvoWork',
    appVersion: '0.0.1',
    onAddCustomModel: vi.fn(),
    onUpdateCustomModel: vi.fn(),
    onRemoveCustomModel: vi.fn(),
    onTestCustomModel: vi.fn(async () => ({ ok: true, message: '通了：这把密钥能调用这个模型。' })),
    onOpenModelsFolder: vi.fn(),
    onOpenProviderDocs: vi.fn(),
    onSecretFallback: vi.fn(),
    onProbe: vi.fn(),
    onPreferences: vi.fn(),
    onMemorySettings: vi.fn(),
    onResetMemories: vi.fn(),
    ...over,
  };
  render(<SettingsPage {...props} />);
  return props;
}

describe('个性化记忆', () => {
  it('显示 Codex 当前支持的全局开关与准备状态', () => {
    page({ section: 'personalization' });
    expect(screen.getByRole('heading', { name: '个性化' })).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: '启用本地记忆' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText('记忆已就绪，已整理 4 个任务。')).toBeTruthy();
  });

  it('V1 明确说明没有整理进度，不伪装成永远在学习', () => {
    page({
      section: 'personalization',
      memory: { ...MEMORY, version: 'v1', statusSupported: false, ready: false },
    });
    expect(screen.getByText(/记忆管线（V1）不提供整理进度/)).toBeTruthy();
    expect(screen.queryByText(/正在学习/)).toBeNull();
  });

  it('使用与生成分开保存，关闭总开关后从属项不可编辑', () => {
    const props = page({ section: 'personalization' });
    fireEvent.click(screen.getByRole('checkbox', { name: '允许任务生成新记忆' }));
    expect(props.onMemorySettings).toHaveBeenCalledWith({
      enabled: true,
      useMemories: true,
      generateMemories: false,
    });

    page({ section: 'personalization', memory: { ...MEMORY, enabled: false } });
    expect(
      (
        screen
          .getAllByRole('checkbox', { name: '在新任务中使用已有记忆' })
          .at(-1) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it('清空全部记忆需要确认，并说明不会删除项目规则与任务历史', () => {
    const props = page({ section: 'personalization' });
    fireEvent.click(screen.getByRole('button', { name: '清空全部本地记忆' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText(/AGENTS.md 和任务历史不会被删除/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    expect(props.onResetMemories).toHaveBeenCalled();
  });

  it('内核缺少实验方法时显式禁用对应控件', () => {
    page({
      section: 'personalization',
      memory: { ...MEMORY, resetSupported: false, taskModeSupported: false },
    });
    expect(
      (screen.getByRole('button', { name: '清空全部本地记忆' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/输入区将使用全局设置/)).toBeTruthy();
    expect(screen.getByText(/不支持清空全部本地记忆/)).toBeTruthy();
  });
});

describe('SecretInput（01 §5.35）', () => {
  it('已保存态显示后四位，**并且没有输入框** —— 空框旁写着「已保存」读起来像没保存上', () => {
    render(<SecretInput label="DeepSeek API 密钥" saved last4="3f9a" onSave={vi.fn()} />);
    expect(screen.getByText('已保存 · ****3f9a')).toBeTruthy();
    expect(screen.queryByLabelText('DeepSeek API 密钥')).toBeNull();
  });

  it('保存之后草稿立刻清空 —— 渲染层不留着那个值', () => {
    const onSave = vi.fn();
    render(<SecretInput label="密钥" saved={false} onSave={onSave} />);
    const input = screen.getByLabelText('密钥') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-abc' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('sk-abc');
    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('');
  });

  it('输入框是 password，且**没有"显示密码"按钮**（旁边可能坐着别人）', () => {
    render(<SecretInput label="密钥" saved={false} onSave={vi.fn()} />);
    expect((screen.getByLabelText('密钥') as HTMLInputElement).type).toBe('password');
    expect(screen.queryByRole('button', { name: /显示/ })).toBeNull();
  });

  it('空值不能保存（按钮禁用）—— 一次空保存会看起来像"清除"', () => {
    render(<SecretInput label="密钥" saved={false} onSave={vi.fn()} />);
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('「清除」是显式动作，且只在已保存时出现', () => {
    const onClear = vi.fn();
    render(<SecretInput label="密钥" saved last4="3f9a" onSave={vi.fn()} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('模型', () => {
  it('账号下面的入口与页面标题都叫「模型」，不再暴露旧名称「模型接入」', () => {
    page();
    const account = screen.getByRole('button', { name: '账号' });
    const models = screen.getByRole('button', { name: '模型' });
    expect(account.nextElementSibling).toBe(models);
    expect(screen.getByRole('heading', { name: '模型' })).toBeTruthy();
    expect(screen.queryByText('模型接入')).toBeNull();
  });

  it('主区就是那张自定义模型卡片，并**如实标出宿主给的真实落盘路径**', () => {
    page();
    expect(screen.getByRole('heading', { name: '自定义模型' })).toBeTruthy();
    expect(screen.getByText(/模型添加后会自动写入到本地/)).toBeTruthy();
    // 路径不是渲染层拼死的：`EVOWORK_HOME` 被指到别处时这一行必须跟着变
    expect(screen.getByRole('button', { name: '~/somewhere/models.toml' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加模型' })).toBeTruthy();
  });

  it('路径是个链接：点它在访达里打开那个目录（点了没反应的链接不如纯文本）', () => {
    const onOpenModelsFolder = vi.fn();
    page({ onOpenModelsFolder });
    fireEvent.click(screen.getByRole('button', { name: '~/somewhere/models.toml' }));
    expect(onOpenModelsFolder).toHaveBeenCalled();
  });

  it('没注入 shell 时那个链接**禁用**，而不是点了什么都不发生', () => {
    page({ onOpenModelsFolder: undefined });
    expect(
      (screen.getByRole('button', { name: '~/somewhere/models.toml' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('每行是 id + 「自定义」+ 三个动作（改 · 测连通 · 删）', () => {
    const props = page({ access: { ...ACCESS, customModels: [custom()] } });
    expect(screen.getByText('deepseek/deepseek-v4-flash-0731')).toBeTruthy();
    expect(screen.getByText('自定义')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: '检查 deepseek/deepseek-v4-flash-0731 连接' }),
    );
    expect(props.onProbe).toHaveBeenCalledWith('deepseek/deepseek-v4-flash-0731');
    fireEvent.click(screen.getByRole('button', { name: '删除 deepseek/deepseek-v4-flash-0731' }));
    expect(props.onRemoveCustomModel).toHaveBeenCalledWith('deepseek/deepseek-v4-flash-0731');
    expect(
      screen.getByRole('button', { name: '修改 deepseek/deepseek-v4-flash-0731' }),
    ).toBeTruthy();
  });

  it('缺密钥的那一行**多一句话**：它在下拉里看着正常、发出去 401', () => {
    page({
      access: { ...ACCESS, customModels: [custom({ keySaved: false, keyLast4: undefined })] },
    });
    expect(screen.getByText(/还没有密钥/)).toBeTruthy();
  });

  it('铅笔打开的弹窗预填那一条，且**不要求重填密钥**（留空 = 沿用已存的那把）', () => {
    const props = page({ access: { ...ACCESS, customModels: [custom()] } });
    fireEvent.click(screen.getByRole('button', { name: '修改 deepseek/deepseek-v4-flash-0731' }));
    expect(screen.getByRole('button', { name: '供应商' }).textContent).toContain('DeepSeek');
    expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe(
      'deepseek-v4-flash-0731',
    );
    // 密钥框是空的，但它的占位说清了"已经有一把"
    expect((screen.getByLabelText('API Key') as HTMLInputElement).placeholder).toContain('3f9a');
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: '保存' }));
    expect(props.onUpdateCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({ previousId: 'deepseek/deepseek-v4-flash-0731' }),
    );
    // **没有 apiKey 字段** = 不动已存的那把（协议里就是这个语义）
    expect(vi.mocked(props.onUpdateCustomModel).mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
  });

  it('改一条指向自建代理的模型时 endpoint 那一行**露出来** —— 藏起来等于保存时偷偷改回官方', () => {
    page({
      access: {
        ...ACCESS,
        customModels: [custom({ baseUrl: 'https://proxy.internal/v1' })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '修改 deepseek/deepseek-v4-flash-0731' }));
    expect((screen.getByDisplayValue('https://proxy.internal/v1') as HTMLInputElement).type).toBe(
      'text',
    );
  });

  it('密钥存放位置只在**降级**时说（明文兜底必须看起来就是一种降级）', () => {
    page({ access: { ...ACCESS, secretBackend: 'plaintext-fallback' } });
    expect(screen.getByText(/明文文件（你选择的兜底方式）/)).toBeTruthy();
  });

  it('存在钥匙串里时不摆那一行 —— 它没有信息量，而附件里这一页只有那张卡', () => {
    page();
    expect(screen.queryByText(/密钥存放位置/)).toBeNull();
    expect(screen.queryByText(/上游形态/)).toBeNull();
  });

  /*
   * 引导里填过 DeepSeek、目录里也有那条内置模型时，这一页**仍然只有那张卡**。
   * 代价是已知的（11 §4.4.1，2026-09-19）：内置密钥只能重跑引导改，
   * 被企业停用的模型不在这一页列出。这条断言就是为了让"又长回来"变红。
   */
  it('引导里填过密钥、目录里有内置模型时，这一页仍然只有那张卡', () => {
    page({
      access: {
        ...ACCESS,
        models: [model(), model({ id: 'x/y', label: 'x/y', credentialSource: 'hosted' })],
      },
    });
    expect(screen.getByRole('heading', { name: '自定义模型' })).toBeTruthy();
    expect(screen.queryByText('内置厂商密钥')).toBeNull();
    expect(screen.queryByText('已保存 · ****3f9a')).toBeNull();
    expect(screen.queryByText('其他可用模型')).toBeNull();
    expect(screen.queryByRole('table', { name: '可用模型' })).toBeNull();
  });

  it('钥匙串不可用：两个选项**并列**，不替用户选', () => {
    const props = page({
      access: {
        ...ACCESS,
        secretBackend: 'unavailable',
        secretNotice: '这台电脑上没有可用的系统密钥库…',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /以明文文件保存/ }));
    expect(props.onSecretFallback).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: /不保存/ }));
    expect(props.onSecretFallback).toHaveBeenCalledWith(false);
  });

  it('企业锁了自定义模型：按钮禁用**并给原因**，不隐藏入口', () => {
    page({
      access: { ...ACCESS, allowCustomModels: false, lockedReason: '你所在组织要求统一配置。' },
    });
    const button = screen.getByRole('button', { name: '添加模型' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('你所在组织要求统一配置。');
    expect(screen.getByText('你所在组织要求统一配置。')).toBeTruthy();
  });

  it('添加模型：**供应商没选就不能提交**，endpoint 方言不能靠猜', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'qwen3-max' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    expect(
      (
        within(screen.getByRole('dialog')).getByRole('button', {
          name: '保存',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('选了内置供应商就不问 endpoint（地址与网关同一张表）；选「其他」才问', () => {
    const props = page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    expect(screen.queryByPlaceholderText('https://example.com/v1')).toBeNull();

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'deepseek-v4' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
    expect(props.onAddCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'deepseek/deepseek-v4',
        provider: 'deepseek',
        // 与 services/gateway 的 DEFAULT_BASE_URL 一致：两处不一致 = 这里测得通、真跑 404
        baseUrl: 'https://api.deepseek.com/v1',
      }),
    );
  });

  it('选「其他 OpenAI 兼容」时必须自己填 endpoint', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '其他 OpenAI 兼容 API' }));
    expect(screen.getByPlaceholderText('https://example.com/v1')).toBeTruthy();
  });

  it('选「其他 OpenAI 兼容」时没填 endpoint，「测试连接」仍禁用并说原因', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '其他 OpenAI 兼容 API' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    const button = screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('先填 endpoint 地址');
  });

  it('API Key 的明文开关默认关着（旁边可能坐着别人），且只作用于**正在打的那个值**', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const input = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: '显示 API Key' }));
    expect((screen.getByLabelText('API Key') as HTMLInputElement).type).toBe('text');
  });

  it('「测试连接」把结论显示在**弹窗里**（页顶横幅在模态后面，用户看不见）', async () => {
    const onTestCustomModel = vi.fn(async () => ({
      ok: false,
      message: '上游拒绝了这把密钥（401）。',
    }));
    page({ onTestCustomModel });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(onTestCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      apiKey: 'sk-wrong',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(
      await within(screen.getByRole('dialog')).findByText('上游拒绝了这把密钥（401）。'),
    ).toBeTruthy();
  });

  it('填完 API Key 之后「测试连接」可点 —— 不要求先填模型名（名单就是这一下要拉的）', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const button = screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('先选一个供应商');

    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('先填上 API Key');

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    expect(button.disabled).toBe(false);
  });

  it('测试连接拉回的名单填进「模型名称」下拉', async () => {
    const onTestCustomModel = vi.fn(async () => ({
      ok: true,
      message: '通了：上游返回了 2 个模型。',
      models: ['deepseek-v4-flash', 'deepseek-chat'],
    }));
    page({ onTestCustomModel });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(
      await within(screen.getByRole('dialog')).findByText('通了：上游返回了 2 个模型。'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '选择上游返回的模型名' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-chat' }));
    expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe('deepseek-chat');
  });

  it('测完之后点模型名称输入框也能打开上游名单，不必点右侧箭头', async () => {
    const onTestCustomModel = vi.fn(async () => ({
      ok: true,
      message: '通了：上游返回了 2 个模型。',
      models: ['deepseek-v4-flash', 'deepseek-chat'],
    }));
    page({ onTestCustomModel });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(
      await within(screen.getByRole('dialog')).findByText('通了：上游返回了 2 个模型。'),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('模型名称'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-v4-flash' }));
    expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe('deepseek-v4-flash');
  });

  it('「查看文档」按供应商跳；没选供应商时禁用并说原因', () => {
    const onOpenProviderDocs = vi.fn();
    page({ onOpenProviderDocs });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const link = screen.getByRole('button', { name: /查看文档/ }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    expect(link.title).toBe('先选一个供应商。');

    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'GLM（智谱）API' }));
    fireEvent.click(screen.getByRole('button', { name: /查看文档/ }));
    // 渲染层只递 provider id —— URL 白名单在主进程（11 §6.3）
    expect(onOpenProviderDocs).toHaveBeenCalledWith('zhipu');
  });

  it('「其他 OpenAI 兼容」没有文档可跳，链接禁用并说清那是用户自己的 endpoint', () => {
    page({ onOpenProviderDocs: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '其他 OpenAI 兼容 API' }));
    expect((screen.getByRole('button', { name: /查看文档/ }) as HTMLButtonElement).title).toContain(
      '我们没有它的文档',
    );
  });

  it('模型名称下拉在测过之前禁用；测完才能从上游名单里挑', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const chevron = screen.getByRole('button', {
      name: '选择上游返回的模型名',
    }) as HTMLButtonElement;
    expect(chevron.disabled).toBe(true);
    expect(chevron.title).toContain('先测试连接');
  });

  it('弹窗右上角的 ✕ 与「取消」是同一个动作', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('连通性检查会把结论显示出来（说清是"发了一次请求"的结果）', () => {
    const props = page({
      probeResult: '通了：这个模型现在可以用。',
      access: { ...ACCESS, customModels: [custom()] },
    });
    fireEvent.click(
      screen.getByRole('button', { name: '检查 deepseek/deepseek-v4-flash-0731 连接' }),
    );
    expect(props.onProbe).toHaveBeenCalledWith('deepseek/deepseek-v4-flash-0731');
    expect(screen.getByText('通了：这个模型现在可以用。')).toBeTruthy();
  });

  it('被拒绝的动作把原话显示出来，不吞掉', () => {
    page({ refusal: '已经有一个叫「my/llm」的模型了。' });
    expect(screen.getByText('已经有一个叫「my/llm」的模型了。')).toBeTruthy();
  });
});

/**
 * 「添加模型」的上下文大小（11 §4.4，2026-10-05 按原型落地）。
 *
 * 它决定内核在哪儿压缩早期对话；客户「经常压缩」的投诉就出在这个数上。
 * 守的是三条后果：表外模型发出去的是用户看到的那个数；认得出的型号锁定为表里的值、
 * 不发也不让改；存不进内核目录的数不让保存。
 */
describe('添加模型：上下文大小', () => {
  const CONTEXT_ACCESS: ModelAccessView = {
    ...ACCESS,
    knownContexts: [
      {
        provider: 'deepseek',
        upstreamModel: 'deepseek-flash',
        maxContextTokens: 1_048_576,
        source: '2026-10-05 实测',
      },
    ],
    contextPolicy: { defaultTokens: 256_000, minTokens: 1_000, autoCompactCap: 256_000 },
  };

  function openPrivate(over: Partial<SettingsPageProps> = {}) {
    const props = page({ access: CONTEXT_ACCESS, ...over });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '其他 OpenAI 兼容 API' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'qwen3.8-max' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/v1'), {
      target: { value: 'https://example.com/v1' },
    });
    return props;
  }
  function save() {
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
  }
  function saveButton() {
    return within(screen.getByRole('dialog')).getByRole('button', {
      name: '保存',
    }) as HTMLButtonElement;
  }

  it('表外模型默认 256K，并说出约多少时压缩 —— 发出去的就是用户看到的那个数', () => {
    const props = openPrivate();
    expect(screen.getByRole('button', { name: '上下文大小' }).textContent).toContain(
      '256K（默认）',
    );
    // min(256K 上限, 90% × 256K) = 230.4K
    expect(screen.getByText(/上下文到约 230K 时自动压缩早期对话/)).toBeTruthy();
    save();
    expect(props.onAddCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'private/qwen3.8-max', maxContextTokens: 256_000 }),
    );
  });

  it('选 32K：提示跟着变，发出去的是 32000', () => {
    const props = openPrivate();
    fireEvent.click(screen.getByRole('button', { name: '上下文大小' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '32K' }));
    expect(screen.getByText(/上下文到约 28.8K 时自动压缩早期对话/)).toBeTruthy();
    save();
    expect(props.onAddCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({ maxContextTokens: 32_000 }),
    );
  });

  it('**自定义的数存不进内核目录就不让保存**，并说为什么 —— 否则那条模型会回到 272k 兜底', () => {
    const props = openPrivate();
    fireEvent.click(screen.getByRole('button', { name: '上下文大小' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '自定义…' }));
    const input = screen.getByLabelText('自定义上下文（token）');
    fireEvent.change(input, { target: { value: '500' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('填一个整数，单位是 token，例如 200000。')).toBeTruthy();

    // 千分位照样认
    fireEvent.change(input, { target: { value: '200,000' } });
    expect(saveButton().disabled).toBe(false);
    save();
    expect(props.onAddCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({ maxContextTokens: 200_000 }),
    );
  });

  it('**能力表认得出的型号锁定为表里的值**并说出处；不发这一项 —— 主进程本来就按表覆盖', () => {
    const props = page({ access: CONTEXT_ACCESS });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    // 大小写与空格不影响识别（与 findKnownModel 同一口径）
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: ' DeepSeek-Flash ' } });

    const trigger = screen.getByRole('button', { name: '上下文大小' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain('1,048,576（1M）');
    // 01 §6.3：禁用必须说原因，而且说清怎么才能自己选
    expect(trigger.title).toContain('能力表');
    expect(screen.getByText(/2026-10-05 实测/)).toBeTruthy();
    // 1M 的 90% 远过上限，压缩点就是上限
    expect(screen.getByText(/上下文到约 256K/)).toBeTruthy();

    save();
    expect(vi.mocked(props.onAddCustomModel).mock.calls[0]?.[0]).not.toHaveProperty(
      'maxContextTokens',
    );
  });

  it('修改：预填已存的那个数，保存时带上它', () => {
    const props = page({
      access: {
        ...CONTEXT_ACCESS,
        customModels: [
          custom({
            id: 'private/qwen3.8-max',
            provider: 'private',
            upstreamModel: 'qwen3.8-max',
            baseUrl: 'https://example.com/v1',
            maxContextTokens: 64_000,
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '修改 private/qwen3.8-max' }));
    expect(screen.getByRole('button', { name: '上下文大小' }).textContent).toContain('64K');
    save();
    expect(props.onUpdateCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({ previousId: 'private/qwen3.8-max', maxContextTokens: 64_000 }),
    );
  });

  it('改一条能力表里的模型到表外型号：预选的是默认值，**不是上一个型号的 1M**', () => {
    page({
      access: {
        ...CONTEXT_ACCESS,
        customModels: [
          custom({
            id: 'deepseek/deepseek-flash',
            upstreamModel: 'deepseek-flash',
            maxContextTokens: 1_048_576,
            contextFromTable: true,
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '修改 deepseek/deepseek-flash' }));
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'deepseek-v4-pro' } });
    // 估大是危险方向：带着 1M 过去，内核等不到压缩、上游先拒
    expect(screen.getByRole('button', { name: '上下文大小' }).textContent).toContain(
      '256K（默认）',
    );
  });

  it('列表每行写出上下文；来自能力表的标出来', () => {
    page({
      access: {
        ...CONTEXT_ACCESS,
        customModels: [
          custom({ id: 'private/qwen3.8-max', maxContextTokens: 256_000 }),
          custom({
            id: 'deepseek/deepseek-flash',
            maxContextTokens: 1_048_576,
            contextFromTable: true,
          }),
        ],
      },
    });
    expect(screen.getByText('上下文 256K')).toBeTruthy();
    expect(screen.getByText('上下文 1M · 能力表')).toBeTruthy();
  });
});

describe('账号（M10b）', () => {
  it('未登录显示登录入口，没有密码框（Q33=A）', () => {
    const onLogin = vi.fn();
    page({ section: 'account', onLogin });
    expect(screen.getByText(/当前为本机模式，无需登录/)).toBeTruthy();
    expect(screen.getByText(/不随账号切换/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '在浏览器中登录' })).toBeTruthy();
    expect(screen.queryByLabelText(/密码/)).toBeNull();
  });

  it('已登录写明退出登录不删本机数据，并给出注销走浏览器的入口（Q39）', () => {
    const onLogout = vi.fn();
    const onOpenAccountWeb = vi.fn();
    const onRevokeDevice = vi.fn();
    page({
      section: 'account',
      onLogout,
      onOpenAccountWeb,
      onRevokeDevice,
      access: {
        ...ACCESS,
        signedIn: true,
        role: 'admin',
        devices: [
          { id: 'dev_a', name: '这台电脑', platform: 'linux', lastSeenAt: 1, revoked: false },
        ],
      },
    });
    expect(screen.getByText(/都不会删掉它们/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开管理端' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '在浏览器中注销账号' })).toBeTruthy();
    expect(screen.queryByText(/充值|升级套餐|购买额度/)).toBeNull();
    expect(screen.getByText(/linux/)).toBeTruthy();
  });
});

describe('用量与预算（Q11 的阶段 1）', () => {
  it('预算失焦时才提交，且清空 = 不限（那是一个合法选择，不是错误）', () => {
    const props = page({ section: 'usage' });
    const input = screen.getByLabelText(/token 硬预算/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '200000' } });
    fireEvent.blur(input);
    expect(props.onPreferences).toHaveBeenCalledWith({ taskTokenBudget: 200000 });
  });

  it('说清超预算只有两个动作，**没有"用便宜模型继续"**（Q11：不自动降级）', () => {
    page({ section: 'usage' });
    expect(screen.getByText(/暂停并问你/)).toBeTruthy();
    expect(screen.getByText(/不会自动换成更便宜的模型/)).toBeTruthy();
  });

  it('托管额度用尽时没有充值或升级入口（Q42）', () => {
    page({
      section: 'usage',
      access: { ...ACCESS, signedIn: true, quotaUsed: 10, quotaLimit: 10 },
    });
    expect(screen.getByText(/不会自动换成其他模型/)).toBeTruthy();
    expect(screen.queryByText(/充值|升级套餐|购买额度/)).toBeNull();
  });

  it('并发下拉最多到机器算出来的那个数 —— 只能往下调', () => {
    page({ section: 'usage', preferences: { concurrencyComputed: 2, concurrencyLimit: 2 } });
    fireEvent.click(screen.getByRole('button', { name: /并发上限/ }));
    expect(screen.getByRole('menuitem', { name: '1' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '2' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '3' })).toBeNull();
  });
});

describe('还没做好的两个分区', () => {
  it('数据管理：说清归档管理界面没做，并指出磁盘占用在资料库页', () => {
    page({ section: 'data' });
    expect(screen.getByText(/归档任务的管理界面还没做好/)).toBeTruthy();
    expect(screen.getByText(/资料库/)).toBeTruthy();
  });

  it('安全与权限：没包时说明不锁；档位可视化仍说没做', () => {
    page({ section: 'security' });
    expect(screen.getByText(/没有企业策略包/)).toBeTruthy();
    expect(screen.getByText(/还没做好/)).toBeTruthy();
  });

  it('超期策略包显示设计原句（含恢复路径）', () => {
    page({
      section: 'security',
      access: {
        ...ACCESS,
        policyPack: {
          status: 'expired',
          message: '安全策略已过期，已切换为只读模式。请连接企业网络以更新。',
          disableShare: false,
          disableSlots: false,
          disabledProfiles: [],
        },
      },
    });
    expect(
      screen.getByText('安全策略已过期，已切换为只读模式。请连接企业网络以更新。'),
    ).toBeTruthy();
  });
});

/* ───────────────── 关于与更新（在线升级提案 §4 B4 · 总纲 Q46，按确认过的原型） ───────────────── */

function updateView(over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    currentVersion: '0.0.4',
    availability: 'on',
    signedIn: false,
    autoCheck: false,
    phase: 'idle',
    ...over,
  };
}

const OFFER = {
  version: '0.0.5',
  sizeBytes: 223_000_000,
  notes: ['修复插件页为空', '<b>不当 HTML 渲染</b>'],
  fileName: 'EvoWork-0.0.5-mac-arm64-unsigned.dmg',
};

describe('关于与更新', () => {
  it('未登录：开关写「未登录时也自动检查更新」，默认关；点开是改未登录那一个', () => {
    const onUpdateAutoCheck = vi.fn();
    page({ section: 'about', update: updateView(), onUpdateAutoCheck });
    const box = screen.getByRole('checkbox', {
      name: /未登录时也自动检查更新/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onUpdateAutoCheck).toHaveBeenCalledWith(true);
  });

  it('已登录：开关写「自动检查更新」，默认开，**也能关**（2026-10-03）', () => {
    const onUpdateAutoCheck = vi.fn();
    page({
      section: 'about',
      update: updateView({ signedIn: true, autoCheck: true }),
      onUpdateAutoCheck,
    });
    const box = screen.getByRole('checkbox', { name: /^自动检查更新/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onUpdateAutoCheck).toHaveBeenCalledWith(false);
  });

  it('组织统一分发：没有「检查更新」按钮，也没有开关，说明为什么', () => {
    page({
      section: 'about',
      update: updateView({ availability: 'off' }),
      onUpdateAutoCheck: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/你所在的组织统一分发 EvoWork 的更新/)).toBeTruthy();
  });

  it('签名校验失败：只能再检查一次，**没有任何下载入口**', () => {
    page({
      section: 'about',
      update: updateView({
        phase: 'error',
        error: 'bad-signature',
        message: '收到的版本清单没有通过签名校验，已丢弃。',
      }),
    });
    expect(screen.getByRole('button', { name: '再检查一次' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /下载/ })).toBeNull();
  });

  it('有新版本：卡片给版本、大小、更新说明（纯文本），下载由用户点（Q46-4）', () => {
    const onDownloadUpdate = vi.fn();
    const { container } = render(<></>);
    page({
      section: 'about',
      update: updateView({ phase: 'available', offer: OFFER }),
      onDownloadUpdate,
    });
    expect(screen.getByText(/可以更新/)).toBeTruthy();
    expect(screen.getByText('约 223 MB')).toBeTruthy();
    // 更新说明来自签过名的清单，但仍然只当文本：不让一段说明在设置页里长出链接或按钮
    expect(screen.getByText('<b>不当 HTML 渲染</b>')).toBeTruthy();
    expect(container.ownerDocument.querySelector('.ew-update-notes b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下载 0.0.5' }));
    expect(onDownloadUpdate).toHaveBeenCalled();
  });

  it('有新版本时，「关于与更新」那一项上有一个点 —— 首页不放提示（2026-10-03 定）', () => {
    const dotOnAbout = () =>
      within(screen.getByRole('button', { name: /关于与更新/ })).queryByLabelText('有更新');
    page({ section: 'models', update: updateView({ phase: 'available', offer: OFFER }) });
    expect(dotOnAbout()).toBeTruthy();
    cleanup();
    page({ section: 'models', update: updateView({ phase: 'latest' }) });
    expect(dotOnAbout()).toBeNull();
  });

  it('下好了、退出会打断任务：先列出会被打断什么，确认之后才退出', async () => {
    const impact: UpdateQuitImpactView = {
      runningTasks: ['整理九月周报'],
      upcoming: [
        {
          name: '每日站会纪要',
          at: Date.now() + 3_600_000,
          whenMissed: '那时 EvoWork 没开着的话，6 小时内重新打开会补跑一次。',
        },
      ],
      runtimeInstalling: false,
    };
    const onQuitAndInstall = vi.fn();
    page({
      section: 'about',
      update: updateView({ phase: 'ready', offer: OFFER }),
      onGetUpdateQuitImpact: vi.fn(async () => impact),
      onQuitAndInstall,
    });
    fireEvent.click(screen.getByRole('button', { name: '退出并打开安装包' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/整理九月周报/)).toBeTruthy();
    expect(within(dialog).getByText(/6 小时内重新打开会补跑一次/)).toBeTruthy();
    expect(onQuitAndInstall).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '退出并打开安装包' }));
    expect(onQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('下好了、没有会被打断的事：直接退出并打开，不多问一句', async () => {
    const onQuitAndInstall = vi.fn();
    page({
      section: 'about',
      update: updateView({ phase: 'ready', offer: OFFER }),
      onGetUpdateQuitImpact: vi.fn(async () => ({
        runningTasks: [],
        upcoming: [],
        runtimeInstalling: false,
      })),
      onQuitAndInstall,
    });
    fireEvent.click(screen.getByRole('button', { name: '退出并打开安装包' }));
    await vi.waitFor(() => expect(onQuitAndInstall).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('办公扩展装着但不是这一版要的组件：在这里说，重新安装由用户点（A4）', () => {
    const onInstallRuntime = vi.fn();
    page({
      section: 'about',
      update: updateView(),
      runtime: {
        installed: true,
        outdated: true,
        missing: [],
        supported: true,
        downloadSize: '约 25 MB',
      },
      onInstallRuntime,
    });
    fireEvent.click(screen.getByRole('button', { name: '重新安装（约 25 MB）' }));
    expect(onInstallRuntime).toHaveBeenCalled();
  });
});

describe('电脑操控权限状态与恢复', () => {
  it('AX 与录屏分开显示，AX-only 可启用；系统页链接和重新检查分别可操作', () => {
    const onSettings = vi.fn(),
      onRefresh = vi.fn(),
      onEnabled = vi.fn();
    page({
      section: 'security',
      computerUse: {
        enabled: false,
        state: 'disabled',
        message: '检查完成',
        grants: [],
        component: 'connected',
        permissions: { accessibility: true, screenRecording: false },
      },
      onComputerUseSettings: onSettings,
      onComputerUseRefresh: onRefresh,
      onComputerUseEnabled: onEnabled,
    });
    expect(screen.getByText(/辅助功能：已授权/)).toBeTruthy();
    expect(screen.getByText(/未授权（可使用辅助功能模式）/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '启用电脑操控' }));
    expect(onEnabled).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '打开屏幕录制设置' }));
    expect(onSettings).toHaveBeenCalledWith('screenRecording');
    fireEvent.click(screen.getByRole('button', { name: '重新检查组件与权限' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it.each(['component-error', 'enterprise-blocked'] as const)(
    '%s 禁用启用，但保留恢复检查入口',
    (state) => {
      page({
        section: 'security',
        computerUse: {
          enabled: false,
          state,
          message: '受限',
          grants: [],
          persistentAllowed: false,
        },
      });
      expect(screen.getByRole('button', { name: '启用电脑操控' }).hasAttribute('disabled')).toBe(
        true,
      );
      expect(
        screen.getByRole('button', { name: '重新检查组件与权限' }).hasAttribute('disabled'),
      ).toBe(false);
      expect(screen.getByText(/企业策略禁止持久授权/)).toBeTruthy();
    },
  );
});
