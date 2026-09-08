/**
 * 设置页（11 §4.4）。盯的是本机模式文案、密钥不回读、停用模型仍显示。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SettingsView } from '../src/shared/ipc.js';
import { Settings } from '../src/renderer/views/settings.js';

const SETTINGS: SettingsView = {
  mode: 'local',
  secretStore: { available: true, kind: 'memory', needsChoice: false },
  models: [
    {
      id: 'evowork/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      provider: 'deepseek',
      upstreamModel: 'deepseek-v4-flash',
      credentialSource: 'byok',
      layer: 'builtin',
      disabled: false,
      savedLast4: 'abcd',
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: true,
        promptCache: true,
        imageInput: false,
        maxContextTokens: 128_000,
      },
      notices: [],
    },
    {
      id: 'evowork/kimi-k3',
      displayName: 'Kimi K3',
      provider: 'moonshot',
      upstreamModel: 'kimi-k3',
      credentialSource: 'byok',
      layer: 'enterprise',
      disabled: true,
      disabledReason: '这个模型已被你所在组织停用。',
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: true,
        promptCache: true,
        imageInput: true,
        maxContextTokens: 128_000,
      },
      notices: [],
    },
  ],
  appName: 'EvoWork',
  appVersion: '0.0.0-test',
  userName: '本机用户',
  allowCustomModels: true,
};

describe('设置页', () => {
  it('默认停在模型接入，账号页说本机模式无需登录', () => {
    render(<Settings settings={SETTINGS} />);
    expect(screen.getByRole('button', { name: '模型接入' }).getAttribute('data-selected')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    expect(screen.getByText('当前为本机模式，无需登录')).toBeTruthy();
    expect(screen.getByText(/不随账号切换/)).toBeTruthy();
  });

  it('被企业停用的模型仍然列出原因，密钥只以后四位出现', () => {
    render(<Settings settings={SETTINGS} />);
    expect(screen.getByText('这个模型已被你所在组织停用。')).toBeTruthy();
    expect(screen.getByText('已保存 · ****abcd')).toBeTruthy();
    expect(JSON.stringify(SETTINGS)).not.toContain('apiKey');
  });

  it('保存密钥走回调，完整值不在 settings 里', () => {
    const onSaveKey = vi.fn();
    render(
      <Settings
        settings={{ ...SETTINGS, models: SETTINGS.models.slice(0, 1) }}
        onSaveKey={onSaveKey}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '覆盖' }));
    fireEvent.change(screen.getByLabelText('DeepSeek V4 Flash 的 API 密钥'), {
      target: { value: 'sk-new-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSaveKey).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-new-secret');
  });
});
