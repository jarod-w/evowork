#!/usr/bin/env node
/**
 * **打包产物冒烟：结构对不对 · 签成了什么 · 真的起不起得来。**
 *
 * `scripts/package.mjs` 的四条前置检查全部发生在**打包之前**。打包之后会出什么事它管不着，
 * 而那正是最贵的一类故障：`extraResources` 的 `${os}` 用错一层，electron-builder 会
 * **静默拷一个空目录** —— 应用装上了、图标也对，一启动找不到内核（那条注释就写在
 * `package.mjs` 的开头）。这个脚本就是打包**之后**的那道检查。
 *
 * 它**不是**签名与公证的正式验收（U4 卡在证书上）。没有证书时如实说「这是 ad-hoc 签名，
 * 别的 Mac 下载后会被 Gatekeeper 拦」，不把它说成通过。
 *
 * 用法：
 *   node scripts/package.mjs && node scripts/verify-packaged-app.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'dist/release');

if (process.platform !== 'darwin') {
  console.error('这个脚本只验 macOS 产物；别的平台请在那个平台上跑。');
  process.exit(1);
}

const problems = [];
const notes = [];
function check(ok, message) {
  if (!ok) problems.push(message);
}

// ── ① 找到 .app ────────────────────────────────────────────────────────
if (!existsSync(RELEASE)) {
  console.error(`没有打包产物：${RELEASE}。先跑 node scripts/package.mjs`);
  process.exit(1);
}
const appPath = readdirSync(RELEASE)
  .filter((name) => name.startsWith('mac'))
  .flatMap((dir) => {
    const full = join(RELEASE, dir);
    return readdirSync(full)
      .filter((n) => n.endsWith('.app'))
      .map((n) => join(full, n));
  })[0];
if (!appPath) {
  console.error(`${RELEASE} 下没有 .app`);
  process.exit(1);
}
console.log(`产物：${appPath.replace(ROOT + '/', '')}`);
const resources = join(appPath, 'Contents/Resources');

// ── ② 随包资源：每一项都要在，而且不能是空目录 ─────────────────────────
/*
 * 「存在」不够，要看**大小**：静默拷空目录的那种故障里，目录是在的。
 */
const kernel = join(resources, 'kernel/codex-app-server');
check(existsSync(kernel), `内核二进制不在包里：${kernel}`);
if (existsSync(kernel)) {
  const st = statSync(kernel);
  check(st.size > 1_000_000, `内核二进制只有 ${st.size} 字节 —— 多半是拷了个占位`);
  check((st.mode & 0o111) !== 0, '内核二进制没有可执行位，装上也起不来');
}
for (const [rel, what] of [
  ['plugins', '技能与策略包（K3）'],
  ['config', '配置模板'],
  ['gateway', '本机网关'],
  ['office/NotoSansSC.ttf', '中文字体'],
]) {
  const full = join(resources, rel);
  check(existsSync(full), `${what} 不在包里：Resources/${rel}`);
  if (existsSync(full) && statSync(full).isDirectory()) {
    check(readdirSync(full).length > 0, `${what} 是个空目录：Resources/${rel}`);
  }
}

// ── ③ 对外可见的字符串里不许有内核品牌（K5）────────────────────────────
const plist = join(appPath, 'Contents/Info.plist');
check(existsSync(plist), 'Info.plist 不在');
if (existsSync(plist)) {
  const text = readFileSync(plist, 'utf8');
  check(text.includes('com.evowork.desktop'), 'Info.plist 里的 bundle id 不对');
  check(
    !/codex|openai/i.test(text),
    'Info.plist 里出现了 Codex / OpenAI —— K5 说对外可见字符串不许带内核品牌',
  );
}

// ── ④ 签名：签成了什么，如实说 ─────────────────────────────────────────
/*
 * **`codesign -dv` 把结果写在 stderr 上**，不是 stdout。用 execFileSync 拿返回值
 * 只会拿到空串，于是"没匹配到 adhoc"被当成"有正式签名"——
 * 这个脚本最不该说错的就是这一句，所以两条流都读。
 */
const desc = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
const descText = `${desc.stdout ?? ''}${desc.stderr ?? ''}`;
check(descText.includes('Identifier='), 'codesign -dv 没有输出签名信息');
const adHoc = /Signature\s*=\s*adhoc/i.test(descText);
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
} catch {
  problems.push('codesign --verify 没过 —— 包是坏的，别的 Mac 上会报「已损坏」');
}
if (adHoc) {
  /*
   * ad-hoc 是 `after-pack.mjs` 在没有证书时补的：它让**本机**能打开，
   * 但别的 Mac 从浏览器下载后仍会被 Gatekeeper 拦。这是 U4 的现状，不是通过。
   */
  notes.push(
    'ad-hoc 签名（无 Developer ID）：本机能开，别的 Mac 下载后会被 Gatekeeper 拦（U4 未关闭）',
  );
  try {
    execFileSync('spctl', ['-a', '-t', 'exec', '-vv', appPath], { stdio: 'pipe' });
    problems.push('未签名包竟然通过了 spctl —— 判据写错了，或者这台机器关了 Gatekeeper');
  } catch {
    notes.push('spctl 如预期拒绝了这个包');
  }
} else {
  notes.push('有正式签名，可以继续验公证（xcrun stapler validate）');
}

// ── ⑤ 真的起得来：用一次性 user-data-dir，别碰用户自己的家目录 ─────────
const { _electron: electron } = await import('@playwright/test');
const userData = mkdtempSync(join(tmpdir(), 'evowork-pkg-smoke-'));
const exe = join(appPath, 'Contents/MacOS/EvoWork');
check(existsSync(exe), `可执行文件不在：${exe}`);
if (existsSync(exe) && problems.length === 0) {
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
  let app;
  try {
    /*
     * **用 `EVOWORK_HOME` 隔离，不要去动 `$HOME`。**
     *
     * 第一版用 `--user-data-dir`，没用：应用的家目录是
     * `app.getPath('home') + '/.evowork'`，而那个参数只挪 Chromium 自己的缓存 ——
     * 冒烟于是跑在了**真实用户的数据**上（真任务、真项目、真模型全渲染了出来）。
     *
     * 第二版改成换 `$HOME`，更糟：macOS 在空目录里找不到登录钥匙串，
     * 弹「找不到钥匙串」的**模态框**，应用被卡死在启动，测试只报一句超时。
     *
     * 所以隔离必须由应用自己提供。`EVOWORK_HOME` 就是为这件事补的。
     */
    app = await electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${join(userData, 'chromium')}`],
      env: { ...env, EVOWORK_HOME: join(userData, '.evowork') },
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    /*
     * 干净的 user-data-dir = 从没用过的机器，所以第一屏必然是首次引导。
     * 断言它，而不是"窗口开了" —— 白窗口也算开了。
     */
    await page.getByRole('heading', { name: '欢迎使用 EvoWork' }).waitFor({ timeout: 90_000 });
    notes.push('打包后的应用能启动，并渲染出首次引导');
  } catch (error) {
    problems.push(`打包后的应用起不来或没渲染出界面：${String(error).slice(0, 300)}`);
  } finally {
    await app?.close().catch(() => undefined);
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────
for (const n of notes) console.log(`· ${n}`);
if (problems.length > 0) {
  console.error('\n❌ 打包产物有问题：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✅ 打包产物冒烟通过（不含签名与公证的正式验收 —— 见上面的说明）');
