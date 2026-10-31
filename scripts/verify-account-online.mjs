/* global window, document */
/** 显式在线验收：真实 Electron/安全存储/浏览器/线上 identity/SMTP 收件。不会输出凭据。 */
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const email = process.env.EVOWORK_ACCOUNT_TEST_EMAIL;
const packagedApp = process.env.EVOWORK_ACCOUNT_TEST_APP;
const packageSmoke = Boolean(packagedApp);
const migrationSmoke = process.env.EVOWORK_ACCOUNT_TEST_PHASE === 'migration';
const explicitOrigin = process.env.EVOWORK_ACCOUNT_TEST_ORIGIN;
const bundled = JSON.parse(readFileSync(join(ROOT, 'config/account.json'), 'utf8'));
const sshHost = process.env.EVOWORK_ACCOUNT_TEST_SSH_HOST ?? '43.143.248.70';
if (!email)
  throw new Error('必须显式设置独立验收邮箱 EVOWORK_ACCOUNT_TEST_EMAIL；不要对已有账号运行。');
const directory =
  process.env.EVOWORK_ACCOUNT_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'evowork-account-online-'));
mkdirSync(directory, { recursive: true });
const resume = process.env.EVOWORK_ACCOUNT_RESUME
  ? JSON.parse(readFileSync(process.env.EVOWORK_ACCOUNT_RESUME, 'utf8'))
  : undefined;
if (
  resume &&
  (packageSmoke ||
    !resume.checks?.includes('desktop-signup-real-mail-verification-pkce-login') ||
    !resume.home?.includes('/evowork-account-home-'))
)
  throw new Error('只能恢复本脚本已创建的隔离测试账号');
const home = resume?.home ?? mkdtempSync(join(tmpdir(), 'evowork-account-home-'));
const password = `Ew!${randomBytes(18).toString('base64url')}9`;
const sensitiveValues = [password];
const origin = (explicitOrigin ?? bundled.webOrigin).replace(/\/$/, '');
const evidence = {
  ...resume,
  startedAt: resume?.startedAt ?? new Date().toISOString(),
  ...(resume ? { resumedAt: new Date().toISOString() } : {}),
  home,
  mode: packageSmoke ? 'packaged-smoke' : migrationSmoke ? 'migration-smoke' : 'production-timer',
  origin,
  server: sshHost,
  checks: resume?.checks ?? [],
};
let desktop, browser;
let currentPassword = password;
let cloudCreated = Boolean(resume);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
async function receive(state, after) {
  const source = readFileSync(
    join(ROOT, 'apps/desktop/test/e2e/harness/read-account-mail.py'),
    'utf8',
  );
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const child = execFile(
      'ssh',
      ['-o', 'BatchMode=yes', `root@${sshHost}`, `python3 -c ${quote(source)}`],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    child.stdin.end(JSON.stringify({ state, after, origin }));
    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error('verification mailbox read failed')),
      );
    });
    const result = JSON.parse(output);
    if (result.url) return result;
    if (result.error) throw new Error(`verification mailbox: ${result.error}`);
    await sleep(5_000);
  }
  throw new Error('两分钟内未收到本次验证邮件');
}
async function settings(page) {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '账号', exact: true })
    .click();
}
async function launch() {
  const {
    ELECTRON_RUN_AS_NODE: _ignored,
    EVOWORK_APP_SERVER: _kernelOverride,
    ...env
  } = process.env;
  delete env.EVOWORK_WEB_ORIGIN;
  delete env.EVOWORK_IDENTITY_ORIGIN;
  delete env.EVOWORK_HOSTED_ORIGIN;
  desktop = await electron.launch({
    executablePath: packagedApp ?? require('electron'),
    args: packagedApp
      ? [`--user-data-dir=${join(home, 'electron-profile')}`]
      : [join(ROOT, 'apps/desktop/test/e2e/harness/account-entry.mjs')],
    cwd: ROOT,
    env: {
      ...env,
      EVOWORK_HOME: home,
      ...(!packagedApp && explicitOrigin
        ? { EVOWORK_WEB_ORIGIN: origin, EVOWORK_IDENTITY_ORIGIN: origin }
        : {}),
      EVOWORK_ACCOUNT_TEST_PROFILE: join(home, 'electron-profile'),
      ...(!packagedApp
        ? { EVOWORK_APP_SERVER: join(ROOT, 'build/kernel/mac-arm64/codex-app-server') }
        : {}),
      EVOWORK_DEV: '0',
    },
    timeout: 120_000,
  });
  const page = await desktop.firstWindow();
  await page.getByLabel('需求输入').waitFor({ timeout: 120_000 });
  if (packagedApp) {
    await desktop.evaluate(({ shell }) => {
      globalThis.__accountEvidence = { urls: [], renewals: [] };
      shell.openExternal = async (url) => {
        globalThis.__accountEvidence.urls.push(url);
      };
    });
  }
  await settings(page);
  return page;
}
async function openedUrl(index = 0) {
  await expect
    .poll(() => desktop.evaluate(() => globalThis.__accountEvidence.urls.length), {
      timeout: 10_000,
    })
    .toBeGreaterThan(index);
  return desktop.evaluate((_electron, n) => globalThis.__accountEvidence.urls[n], index);
}
async function stateOf(page) {
  return page.evaluate(() => window.evowork.getModelAccess());
}
function gatewayPid() {
  const children = execFileSync('pgrep', ['-P', String(desktop.process().pid)], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/);
  const processes = execFileSync('ps', ['-o', 'pid=,args=', '-p', children.join(',')], {
    encoding: 'utf8',
  });
  const line = processes.split('\n').find((value) => value.includes('/dist/gateway/main.js'));
  if (!line) throw new Error('没有找到客户端本机网关进程');
  return Number(line.trim().split(/\s+/)[0]);
}
async function post(path, body, token) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
function checkpoint(name) {
  evidence.checks.push(name);
  writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${name}`);
}
try {
  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
  });
  const web = await browser.newPage();
  let page = await launch();
  if (resume) {
    expect((await stateOf(page)).view.signedIn).toBe(true);
    expect((await stateOf(page)).view.secretBackend).toBe('keychain');
    checkpoint('restored-encrypted-session-after-interruption');
  } else {
    expect((await stateOf(page)).view.signedIn).toBe(false);
    if (packageSmoke) {
      await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(480, 600),
      );
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480);
      await expect(page.getByRole('button', { name: '注册账号', exact: true })).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: join(directory, 'desktop-account-entry-480.png') });
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 820),
      );
    }
    await page.getByRole('button', { name: '注册账号', exact: true }).click();
    const signup = new URL(await openedUrl());
    expect(signup.origin).toBe(origin);
    expect(signup.pathname).toBe('/signup');
    const started = Date.now();
    await web.goto(signup.toString());
    await web.getByLabel('邮箱', { exact: true }).fill(email);
    await web.getByLabel('密码', { exact: true }).fill(password);
    await web.getByLabel('确认密码', { exact: true }).fill(password);
    const registered = web.waitForResponse((res) => res.url().endsWith('/v1/signup'));
    await web.getByRole('button', { name: '注册', exact: true }).click();
    expect((await registered).status()).toBe(201);
    cloudCreated = true;
    await web.getByText('请查收验证邮件', { exact: true }).waitFor();
    await web.screenshot({ path: join(directory, 'signup-mail-sent.png') });
    const verify = await receive(signup.searchParams.get('state'), started);
    evidence.verifyMailDigest = verify.mailDigest;
    await web.goto(verify.url);
    await web.getByText('邮箱已验证，可以登录了。', { exact: true }).waitFor();
    await web.getByRole('button', { name: '去登录', exact: true }).click();
    expect(new URL(web.url()).searchParams.get('state')).toBe(signup.searchParams.get('state'));
    await web.getByLabel('邮箱或手机号').fill(email);
    await web.getByLabel('密码', { exact: true }).fill(password);
    await web.getByRole('button', { name: '登录', exact: true }).click();
    await expect
      .poll(async () => (await stateOf(page)).view.signedIn, { timeout: 30_000 })
      .toBe(true);
    expect((await stateOf(page)).view.secretBackend).toBe('keychain');
    await page.getByText('已登录', { exact: true }).waitFor();
    await page.screenshot({ path: join(directory, 'desktop-signed-in.png') });
    if (origin.startsWith('https://')) {
      const cookie = (await web.context().cookies(origin)).find(
        (value) => value.name === 'session',
      );
      expect(cookie?.secure).toBe(true);
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe('Lax');
      evidence.secureCookieVerified = true;
    }
    checkpoint('desktop-signup-real-mail-verification-pkce-login');
  }
  if (!packageSmoke && !migrationSmoke) {
    // 使用真实 15 分钟 JWT 和产品计时器；不缩短线上 TTL、不模拟续期响应。
    const before = await desktop.evaluate(() => globalThis.__accountEvidence.renewals);
    const childrenBefore = gatewayPid();
    console.log('Waiting for the production renewal timer (about 14 minutes)');
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const rotations = await desktop.evaluate(() => globalThis.__accountEvidence.renewals);
      if (rotations.slice(before.length).some((entry) => entry.grant === 'refresh_token')) break;
      await sleep(15_000);
    }
    const after = await desktop.evaluate(() => globalThis.__accountEvidence.renewals);
    const renewed = after.slice(before.length).find((entry) => entry.grant === 'refresh_token');
    expect(renewed).toBeTruthy();
    expect(renewed.refreshDigest).not.toBe(before.at(-1).refreshDigest);
    expect((await stateOf(page)).view.signedIn).toBe(true);
    const childrenAfter = gatewayPid();
    expect(childrenAfter).toBe(childrenBefore);
    evidence.renewals = after;
    checkpoint('real-time-automatic-refresh-without-restarting-gateway');
  }
  await desktop.close();
  desktop = undefined;
  page = await launch();
  await expect
    .poll(async () => (await stateOf(page)).view.signedIn, { timeout: 30_000 })
    .toBe(true);
  checkpoint('encrypted-refresh-restored-after-desktop-restart');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect.poll(async () => (await stateOf(page)).view.signedIn).toBe(false);
  await page.getByRole('button', { name: '在浏览器中登录', exact: true }).click();
  const signin = new URL(await openedUrl());
  await web.goto(signin.toString());
  await web.getByRole('link', { name: '忘记密码？' }).click();
  await web.getByLabel('邮箱', { exact: true }).fill(email);
  const resetSentAt = Date.now();
  await web.getByRole('button', { name: '发送重置邮件', exact: true }).click();
  const reset = await receive(signin.searchParams.get('state'), resetSentAt);
  evidence.resetMailDigest = reset.mailDigest;
  await web.goto(reset.url);
  const nextPassword = `Ew!${randomBytes(18).toString('base64url')}9`;
  sensitiveValues.push(nextPassword);
  await web.getByLabel('新密码', { exact: true }).fill(nextPassword);
  await web.getByLabel('确认新密码', { exact: true }).fill(nextPassword);
  await web.getByRole('button', { name: '更新密码', exact: true }).click();
  await web.getByText('密码已更新', { exact: true }).waitFor();
  currentPassword = nextPassword;
  await web.getByRole('button', { name: '去登录', exact: true }).click();
  await web.getByLabel('邮箱或手机号').fill(email);
  await web.getByLabel('密码', { exact: true }).fill(nextPassword);
  await web.getByRole('button', { name: '登录', exact: true }).click();
  await expect
    .poll(async () => (await stateOf(page)).view.signedIn, { timeout: 30_000 })
    .toBe(true);
  checkpoint('real-reset-mail-new-password-and-desktop-relogin');
  evidence.completedAt = new Date().toISOString();
} catch (error) {
  let summary = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues) summary = summary.replaceAll(value, '[redacted]');
  summary = summary.replace(/([?&](?:token|code)=)[^&\s)]+/g, '$1[redacted]');
  evidence.error = summary;
  if (desktop) {
    const windows = desktop.windows();
    if (windows[0])
      await windows[0]
        .screenshot({ path: join(directory, 'desktop-failure.png') })
        .catch(() => undefined);
  }
  throw new Error(evidence.error);
} finally {
  // 只清本次创建的测试账号；不会注销既有账号或触碰本机真实数据。
  if (cloudCreated) {
    const login = await post('/v1/login', {
      identifier: email,
      password: currentPassword,
      deviceId: 'verification-cleanup',
    });
    if (login.ok) {
      const session = await login.json();
      const deleted = await post(
        '/v1/account/delete',
        { password: currentPassword },
        session.accessToken,
      );
      evidence.cloudTestAccountDeleted = deleted.ok;
    }
  }
  await desktop?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${directory}`);
}
