/**
 * SecretInput（01 §5.35）。盯的是「已保存态把密钥写进 value」。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SecretInput } from '../src/renderer/components/primitives.js';

describe('SecretInput', () => {
  it('已保存态显示后四位，没有带假值的 password 输入', () => {
    render(<SecretInput label="DeepSeek API 密钥" savedLast4="abcd" onSave={() => undefined} />);
    expect(screen.getByText('已保存 · ****abcd')).toBeTruthy();
    expect(screen.queryByLabelText('DeepSeek API 密钥')).toBeNull();
  });

  it('覆盖是空输入，不会把后四位填回去', () => {
    render(<SecretInput label="DeepSeek API 密钥" savedLast4="abcd" onSave={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '覆盖' }));
    const input = screen.getByLabelText('DeepSeek API 密钥') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
  });

  it('形状不对时不提交', () => {
    const onSave = vi.fn();
    render(<SecretInput label="密钥" onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('密钥至少 8 位，且不能含空白。')).toBeTruthy();
  });

  it('清除走确认，不会直接清', () => {
    const onClear = vi.fn();
    render(
      <SecretInput label="密钥" savedLast4="abcd" onSave={() => undefined} onClear={onClear} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onClear).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '清除' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
