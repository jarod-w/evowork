/**
 * 设置页（11 §4.4）与 01 §5.35 SecretInput。
 *
 * 这一屏的断言都是**后果**而不是布局：
 *   · 已保存态不能显示成一个空输入框（读起来像没保存上）；
 *   · 被企业停用的模型**留在表里**（消失的东西无法被排查）；
 *   · 钥匙串不可用时两个选项并列（不替用户选）；
 *   · 并发上限只能往下调（机器就是资源上限）。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SecretInput } from '../src/renderer/components/primitives.js';
import { SettingsPage, type SettingsPageProps } from '../src/renderer/views/settings.js';
import type { CustomModelView, ModelAccessView, ModelOptionView } from '../src/shared/ipc.js';

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

function page(over: Partial<SettingsPageProps> = {}) {
  const props: SettingsPageProps = {
    section: 'models',
    onSection: vi.fn(),
    access: ACCESS,
    preferences: { concurrencyComputed: 3, concurrencyLimit: 3 },
    appName: 'EvoWork',
    appVersion: '0.0.1',
    onSaveProviderKey: vi.fn(),
    onClearProviderKey: vi.fn(),
    onAddCustomModel: vi.fn(),
    onUpdateCustomModel: vi.fn(),
    onRemoveCustomModel: vi.fn(),
    onTestCustomModel: vi.fn(async () => ({ ok: true, message: '通了：这把密钥能调用这个模型。' })),
    onOpenModelsFolder: vi.fn(),
    onOpenProviderDocs: vi.fn(),
    onSecretFallback: vi.fn(),
    onProbe: vi.fn(),
    onPreferences: vi.fn(),
    ...over,
  };
  render(<SettingsPage {...props} />);
  return props;
}

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

  it('内置厂商只列**已经存过**的那几把（新加一家走「添加模型」）', () => {
    page();
    // 引导里填过 DeepSeek：必须留一个能改能清的入口，否则填错了没处改
    expect(screen.getByText('已保存 · ****3f9a')).toBeTruthy();
    // Kimi 没填过：不再摆一个空框（那会让人以为这才是加模型的正路）
    expect(screen.queryByLabelText('Kimi（Moonshot） API 密钥')).toBeNull();
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

  it('每条模型都标凭据来源（它回答"花谁的钱、数据过谁的境"）', () => {
    page({
      access: {
        ...ACCESS,
        models: [model(), model({ id: 'x/y', label: 'x/y', credentialSource: 'hosted' })],
      },
    });
    expect(screen.getByText('你的密钥')).toBeTruthy();
    expect(screen.getByText('由管理员配置')).toBeTruthy();
  });

  it('被企业停用的模型**仍然在表里**，带原因、且没有「检查」按钮', () => {
    page({
      access: { ...ACCESS, models: [model({ denied: '这个模型已被你所在组织停用。' })] },
    });
    expect(screen.getByText('deepseek/deepseek-v4-flash')).toBeTruthy();
    expect(screen.getByText('这个模型已被你所在组织停用。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '检查' })).toBeNull();
  });

  it('自定义模型的能力位标「未实测（手填）」 —— 那是用户的声明，不是我们的结论', () => {
    page({ access: { ...ACCESS, models: [model({ verified: false, layer: 'custom' })] } });
    expect(screen.getByText('未实测（手填）')).toBeTruthy();
  });

  it('卡片已经逐行列出的模型不在下面重复一遍（全是自定义模型时那张表整段消失）', () => {
    page({
      access: {
        ...ACCESS,
        customModels: [custom()],
        models: [
          model({
            id: 'deepseek/deepseek-v4-flash-0731',
            label: 'deepseek/deepseek-v4-flash-0731',
          }),
        ],
      },
    });
    expect(screen.queryByRole('table', { name: '可用模型' })).toBeNull();
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
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'deepseek-v4' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(onTestCustomModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4',
        apiKey: 'sk-wrong',
      }),
    );
    expect(
      await within(screen.getByRole('dialog')).findByText('上游拒绝了这把密钥（401）。'),
    ).toBeTruthy();
  });

  it('测试连接在填全之前禁用**并给原因**（一次空请求的结果只会让人更困惑）', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const button = screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('先选供应商');
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

  it('模型名称的下拉只放**实测过的**那几个，没有可挑的时候 chevron 禁用并给原因', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    // 还没选供应商 → 没有建议
    expect(
      (screen.getByRole('button', { name: '选择实测过的模型名' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '供应商' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API' }));
    fireEvent.click(screen.getByRole('button', { name: '选择实测过的模型名' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-v4-flash' }));
    expect((screen.getByLabelText('模型名称') as HTMLInputElement).value).toBe('deepseek-v4-flash');
  });

  it('弹窗右上角的 ✕ 与「取消」是同一个动作', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('连通性检查会把结论显示出来（说清是"发了一次请求"的结果）', () => {
    const props = page({ probeResult: '通了：这个模型现在可以用。' });
    fireEvent.click(screen.getByRole('button', { name: '检查' }));
    expect(props.onProbe).toHaveBeenCalledWith('evowork/deepseek-v4-flash');
    expect(screen.getByText('通了：这个模型现在可以用。')).toBeTruthy();
  });

  it('被拒绝的动作把原话显示出来，不吞掉', () => {
    page({ refusal: '已经有一个叫「my/llm」的模型了。' });
    expect(screen.getByText('已经有一个叫「my/llm」的模型了。')).toBeTruthy();
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
