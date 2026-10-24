/**
 * 验收决定跟着这一版交付走。产物或文件一变，上次的接受就不再算数。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AcceptancePanel,
  deliveryFingerprint,
  readStoredAcceptance,
} from '../src/renderer/components/acceptance-panel.js';

const ARTIFACT = {
  id: 'a1',
  name: '季度报告.docx',
  version: 1,
  artifactType: 'document',
};

describe('验收这一版', () => {
  beforeEach(() => localStorage.clear());

  it('没有交付时不能接受空的一版', () => {
    render(
      <AcceptancePanel threadId="t1" status="completed" artifacts={[]} files={[]} blocked={[]} />,
    );
    expect(screen.getByText('还没有可以验收的交付')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '接受这一版' })).toBeNull();
  });

  it('接受只对当前指纹有效，版本变了要重新确认', () => {
    const onRequestChanges = vi.fn();
    const view = render(
      <AcceptancePanel
        threadId="t1"
        status="completed"
        artifacts={[ARTIFACT]}
        files={[{ path: '/w/季度报告.docx' }]}
        blocked={[
          {
            id: 'blocked:t1',
            kind: 'blocked',
            title: '季度报告',
            detail: '已拦住对密钥与凭据的访问',
            threadId: 't1',
          },
        ]}
        onRequestChanges={onRequestChanges}
      />,
    );
    expect(screen.getByText('已拦住对密钥与凭据的访问')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '接受这一版' }));
    expect(screen.getByText('已接受这一版')).toBeTruthy();
    expect(readStoredAcceptance('t1')?.fingerprint).toBe(
      deliveryFingerprint({ artifacts: [ARTIFACT], files: [{ path: '/w/季度报告.docx' }] }),
    );

    view.rerender(
      <AcceptancePanel
        threadId="t1"
        status="completed"
        artifacts={[{ ...ARTIFACT, version: 2 }]}
        files={[{ path: '/w/季度报告.docx' }]}
        blocked={[]}
        onRequestChanges={onRequestChanges}
      />,
    );
    expect(screen.getByText('交付已经变了，上次的决定不再算数。')).toBeTruthy();
    expect(screen.queryByText('已接受这一版')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    expect(onRequestChanges).toHaveBeenCalledOnce();
    expect(screen.getByText('已退回修改')).toBeTruthy();
  });
});
