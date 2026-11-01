import { describe, expect, it } from 'vitest';
import { decodeProbeFrame, evaluateNativePreflight } from '../verify-computer-use-preflight.mjs';

const ready = () => ({
  buildVersion: '0.0.8',
  health: { protocolVersion: 1, buildVersion: '0.0.8', accessibility: true, screenRecording: true },
  signingIdentityCount: 1,
  host: { trusted: true, identifier: 'com.evowork.desktop', team: 'AAAAAAAAAA' },
  helper: { trusted: true, identifier: 'com.evowork.desktop.computer-use', team: 'AAAAAAAAAA' },
  untrustedReads: [{ app: 'com.apple.TextEdit', ok: false, code: 'POLICY_DENIED' }],
  apps: ['wechat', 'textedit', 'wps'].map((name) => ({
    name,
    installed: true,
    trusted: true,
    identifier: name,
    expectedIdentifier: name,
  })),
});

describe('原生验收前置必须如实报告阻塞，不能替代 AX/TCC 验收', () => {
  it('所有前置齐全也只表示 ready，不标记原生验收通过或打开发布闸门', () => {
    expect(evaluateNativePreflight(ready())).toEqual({
      status: 'ready',
      failures: [],
      blockers: [],
      nativeAcceptanceCompleted: false,
      publicationGateChanged: false,
    });
  });
  it('无证书、ad-hoc 宿主/Helper 和缺辅助功能权限均明确阻塞', () => {
    const report = ready();
    report.signingIdentityCount = 0;
    report.host = { trusted: false };
    report.helper = { trusted: false };
    report.health.accessibility = false;
    const result = evaluateNativePreflight(report);
    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'NO_CODE_SIGNING_IDENTITY',
        'SIGNED_DESKTOP_HOST_REQUIRED',
        'SIGNED_NATIVE_HELPER_REQUIRED',
        'ACCESSIBILITY_TCC_REQUIRED',
      ]),
    );
  });
  it('有效但不同团队或错误宿主标识仍不能进入原生验收', () => {
    const report = ready();
    report.helper.team = 'BBBBBBBBBB';
    report.host.identifier = 'com.other.host';
    expect(evaluateNativePreflight(report).blockers).toEqual(
      expect.arrayContaining(['HOST_HELPER_TEAM_MISMATCH', 'SIGNED_DESKTOP_HOST_REQUIRED']),
    );
  });
  it('非受信调用未拒绝、缺负向证据或 health 版本/字段异常必须失败，不能算环境跳过', () => {
    for (const change of [
      (r) => {
        r.untrustedReads[0].ok = true;
      },
      (r) => {
        r.untrustedReads = [];
      },
      (r) => {
        r.health.buildVersion = 'old';
      },
      (r) => {
        r.health.accessibility = 'true';
      },
    ]) {
      const report = ready();
      change(report);
      expect(evaluateNativePreflight(report).status).toBe('failed');
    }
  });
  it('仅有办公室安装目录、标识错配或缺录屏权限不算通过', () => {
    const report = ready();
    report.apps[2].trusted = false;
    report.apps[0].identifier = 'forged';
    report.health.screenRecording = false;
    expect(evaluateNativePreflight(report).blockers).toEqual(
      expect.arrayContaining([
        'OFFICE_APP_UNVERIFIED',
        'TARGET_APP_UNVERIFIED:wechat',
        'SCREEN_RECORDING_TCC_REQUIRED',
      ]),
    );
  });
  it('长度帧拒绝截断、拼接多帧和无类型结果', () => {
    const frame = (value) => {
      const body = Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      return Buffer.concat([header, body]);
    };
    const valid = frame({ ok: false, code: 'POLICY_DENIED' });
    expect(decodeProbeFrame(valid)).toEqual({ ok: false, code: 'POLICY_DENIED' });
    for (const bytes of [valid.subarray(1), Buffer.concat([valid, valid]), frame({ ok: 'true' })])
      expect(() => decodeProbeFrame(bytes)).toThrow();
  });
});
