import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computerUseEnterpriseAccess } from '@evowork/policy';
import { createComputerUsePolicyReader } from '../src/main/computer-use-policy.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ew-cu-policy-'));
  roots.push(root);
  const requirementsPath = join(root, 'requirements.toml');
  const readManaged = vi.fn(async (): Promise<unknown> => null);
  let expired = false;
  const read = createComputerUsePolicyReader({
    requirementsPath,
    readManaged,
    readOnly: () => expired,
  });
  return {
    read,
    readManaged,
    requirementsPath,
    expire: () => {
      expired = true;
    },
  };
}
describe('P2 宿主有效企业策略读取器', () => {
  it('解析真实 TOML，引号、大小写和单层默认应用例外都有效；不忽略无关策略文件', async () => {
    const s = setup();
    writeFileSync(
      s.requirementsPath,
      `allow_managed_hooks_only = true\n[computer_use]\ndefault_app_access = 'deny'\nallow_persistent_approval = false\n[computer_use.macos.bundle_ids]\n'com.apple.TextEdit' = 'allow'\n`,
    );
    const policy = await s.read();
    expect(policy.enabled).toBe(true);
    expect(policy.persistentAllowed).toBe(false);
    expect(computerUseEnterpriseAccess(policy, 'com.apple.TextEdit')).toBe('allow');
    expect(computerUseEnterpriseAccess(policy, 'com.apple.Notes')).toBe('deny');
  });
  it('本机 allow 不盖过真实 managed deny', async () => {
    const s = setup();
    writeFileSync(
      s.requirementsPath,
      "[computer_use.macos.bundle_ids]\n'com.apple.TextEdit' = 'allow'\n",
    );
    s.readManaged.mockResolvedValue({
      computerUse: { macos: { bundleIds: { 'com.apple.TextEdit': 'deny' } } },
    });
    expect(computerUseEnterpriseAccess(await s.read(), 'com.apple.TextEdit')).toBe('deny');
  });
  it('读取失败或 TOML 损坏保守禁用；文件更新立刻重读', async () => {
    const s = setup();
    writeFileSync(s.requirementsPath, 'computer_use = [');
    expect((await s.read()).enabled).toBe(false);
    writeFileSync(s.requirementsPath, 'allow_browser_and_computer_use = true');
    expect((await s.read()).enabled).toBe(true);
    s.readManaged.mockRejectedValue(new Error('unavailable'));
    expect((await s.read()).enabled).toBe(false);
  });
  it('过期只读禁止控制，即使旧文件和内核都允许；RPC 返回期间过期也拒绝', async () => {
    const s = setup();
    s.readManaged.mockImplementation(async () => {
      s.expire();
      return { allowBrowserAndComputerUse: true };
    });
    expect((await s.read()).enabled).toBe(false);
    s.readManaged.mockClear();
    expect((await s.read()).enabled).toBe(false);
    expect(s.readManaged).not.toHaveBeenCalled();
  });
});
