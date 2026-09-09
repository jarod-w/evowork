/**
 * 设置页（11 §4.4）与 01 §5.35 SecretInput。
 *
 * 这一屏的断言都是**后果**而不是布局：
 *   · 已保存态不能显示成一个空输入框（读起来像没保存上）；
 *   · 被企业停用的模型**留在表里**（消失的东西无法被排查）；
 *   · 钥匙串不可用时两个选项并列（不替用户选）；
 *   · 并发上限只能往下调（机器就是资源上限）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SecretInput } from '../src/renderer/components/primitives.js';
import { SettingsPage, type SettingsPageProps } from '../src/renderer/views/settings.js';
import type { ModelAccessView, ModelOptionView } from '../src/shared/ipc.js';

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

const ACCESS: ModelAccessView = {
  mode: 'local',
  secretBackend: 'keychain',
  providers: [
    { id: 'deepseek', label: 'DeepSeek', saved: true, last4: '3f9a' },
    { id: 'moonshot', label: 'Kimi（Moonshot）', saved: false },
  ],
  customModels: [],
  models: [model()],
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
    onRemoveCustomModel: vi.fn(),
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

describe('模型接入', () => {
  it('列出内置三家与它们的已保存状态（没配的也列出来）', () => {
    page();
    expect(screen.getByText('已保存 · ****3f9a')).toBeTruthy();
    expect(screen.getByLabelText('Kimi（Moonshot） API 密钥')).toBeTruthy();
  });

  it('密钥存放位置**显示给用户** —— 明文兜底必须看起来就是一种降级', () => {
    page({ access: { ...ACCESS, secretBackend: 'plaintext-fallback' } });
    expect(screen.getByText(/明文文件（你选择的兜底方式）/)).toBeTruthy();
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

  it('企业锁了自定义模型：按钮禁用**并给原因**，不隐藏入口', () => {
    page({
      access: { ...ACCESS, allowCustomModels: false, lockedReason: '你所在组织要求统一配置。' },
    });
    const button = screen.getByRole('button', { name: '添加模型' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('你所在组织要求统一配置。');
    expect(screen.getByText('你所在组织要求统一配置。')).toBeTruthy();
  });

  it('添加自定义模型：**协议适配类型没选就不能提交**', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByPlaceholderText('my/llm'), { target: { value: 'my/llm' } });
    fireEvent.change(screen.getByPlaceholderText('qwen3-max'), { target: { value: 'q' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/v1'), {
      target: { value: 'https://example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-x' } });
    // 四个字段都填了，但协议适配类型还没选
    expect((screen.getByRole('button', { name: '添加' }) as HTMLButtonElement).disabled).toBe(true);
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
