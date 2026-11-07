import { expect, it } from 'vitest';
import {
  appTestPath,
  appTestEnvironment,
  kernelTestEnvironment,
} from '../../apps/desktop/test/e2e/harness/app-test-path.mjs';

it('app discards inherited agent host overrides without changing its own fixture configuration', () => {
  const env = {
    CODEX_SHELL: '/developer/pwsh',
    CODEX_THREAD_ID: 'foreign-session',
    ELECTRON_RUN_AS_NODE: '1',
    EVOWORK_UI_REAL_MODEL: '1',
    SHELL: '/system/powershell',
  };
  expect(appTestEnvironment(env)).toEqual({
    EVOWORK_UI_REAL_MODEL: '1',
    SHELL: '/system/powershell',
  });
  expect(env.CODEX_SHELL).toBe('/developer/pwsh');
});

it('Windows app keeps its runtime and system tools without inheriting developer patch shims', () => {
  const keep = ['D:\\tools\\node', 'D:\\office runtime', 'C:\\Windows\\System32'];
  const injected = [
    'C:\\Users\\u\\.codex\\tmp\\arg0-windows\\session',
    'C:\\Users\\u\\.cache\\codex-runtimes\\runtime\\native\\powershell',
    'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\build',
  ];
  expect(appTestPath([...keep, ...injected].join(';'), ';')).toBe(keep.join(';'));
});

it('POSIX app removes transient developer paths and preserves ordinary user commands', () => {
  expect(appTestPath('/usr/bin:/home/u/.codex/tmp/shim:/home/u/bin', ':')).toBe(
    '/usr/bin:/home/u/bin',
  );
});

it('kernel shell cannot inherit the provider credential, while local gateway and MCP routing remain usable', () => {
  const env = {
    HOME: '/user',
    EVOWORK_UI_MODEL_KEY: 'provider-secret',
    DEEPSEEK_API_KEY: 'provider-secret',
    EVOWORK_GATEWAY_TOKEN: 'local-token',
    EVOWORK_OFFICE_PYTHON: '/office/python',
  };
  const isolated = kernelTestEnvironment(env, '/test-home', 'provider-secret', 'linux');
  expect(isolated).toEqual({
    HOME: '/test-home',
    EVOWORK_GATEWAY_TOKEN: 'local-token',
    EVOWORK_OFFICE_PYTHON: '/office/python',
  });
  expect(env.DEEPSEEK_API_KEY).toBe('provider-secret');
});

it('Windows native user-skill discovery uses the disposable test profile, not the host profile', () => {
  const env = { HOME: 'C:\\real-home', USERPROFILE: 'C:\\real-home' };
  const isolated = kernelTestEnvironment(env, 'C:\\test-home', undefined, 'win32');
  expect(isolated.HOME).toBe('C:\\test-home');
  expect(isolated.USERPROFILE).toBe('C:\\test-home');
  expect(env.USERPROFILE).toBe('C:\\real-home');
});

it('POSIX home isolation leaves unrelated Windows variables unchanged', () => {
  const isolated = kernelTestEnvironment(
    { USERPROFILE: 'unrelated' },
    '/test-home',
    undefined,
    'linux',
  );
  expect(isolated.HOME).toBe('/test-home');
  expect(isolated.USERPROFILE).toBe('unrelated');
});
