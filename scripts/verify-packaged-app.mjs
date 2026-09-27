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

/*
 * 临时目录的清理。此前这个脚本的每一段都建了目录、一个都没删 ——
 * 跑几十次之后 /var/folders 下攒了几个 GB，而每一次运行本身都是绿的。
 * 复用 e2e 那份：它只肯删名字里带 `evowork-` 的路径，并且删不掉时**警告而不是失败**
 * （一个全过的验证不该因为收尾而变红）。
 */
import { removeE2EHome } from '../apps/desktop/test/e2e/harness/runner.mjs';

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
  /*
   * `CFBundleURLTypes` —— **macOS 上深链的硬前提**。
   * `app.setAsDefaultProtocolClient` 只能注册**已经写进 Info.plist** 的 scheme，
   * 所以少了这一段，真入口里那行注册就是个空操作，而且不报错。
   * 2026-09-27 实测：当时整段都不在（`build/electron-builder.yml` 没有 `protocols:`），
   * 于是分享页上的「在 EvoWork 中打开」在装出来的应用上点了毫无反应。
   */
  const urlTypes = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleURLTypes', plist], {
    encoding: 'utf8',
  });
  check(
    /\bevowork\b/.test(urlTypes.stdout ?? ''),
    'Info.plist 里没有 evowork 这个 URL scheme —— 系统不会把这个应用认作 evowork:// 的处理者' +
      '（补在 build/electron-builder.yml 的 protocols:）',
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
    removeE2EHome(userData);
  }
}

// ── ⑥ 深链：冷启动 argv 那条路（02 §8）─────────────────────────────────
/*
 * **这一段只验 argv 那条路**，也就是 Windows / Linux 上系统把 URL 当命令行参数递过来的形状。
 * 它不经过注入端口（`handleDeeplink(deeplinkFromArgv(process.argv))` 直接读 `process.argv`），
 * 所以它在那三样全断的时候也是绿的 —— 别把它读成"深链验过了"。
 * **macOS 上真正的冷启动走 `open-url`**，那三样连同它一起在第 ⑦ 段验。
 *
 * 这一条本身是真链路：真进程的 `process.argv` → `deeplinkFromArgv` →
 * `resolveDeeplink` 查本机 → 存成待领 → 渲染层挂载后来领 → 画出来。
 * 它同时验掉一个最容易写错的地方：**冷启动时 React 还没订阅事件**，
 * 直接 `webContents.send` 会把那条深链丢掉，表现正是"点了链接什么都没发生"。
 */
if (existsSync(exe) && problems.length === 0) {
  const { ELECTRON_RUN_AS_NODE: _drop2, ...env } = process.env;
  const deepHome = mkdtempSync(join(tmpdir(), 'evowork-pkg-deeplink-'));
  let app;
  try {
    app = await electron.launch({
      executablePath: exe,
      args: [
        `--user-data-dir=${join(deepHome, 'chromium')}`,
        // 干净的家目录 = 这台机器上没有任何任务，所以这条必然走"不在本机"那一支
        'evowork://task/thr_not_here',
      ],
      env: { ...env, EVOWORK_HOME: join(deepHome, '.evowork') },
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    /*
     * 断言的是**规则 3**：未知 ID 要给明确错误而不是空白页。
     * 这条比"跳对了页面"更值得验 —— 跳错页用户看得见，而静默丢掉看不见。
     */
    await page.getByText('该任务不在本机，可能创建于其他设备。').waitFor({ timeout: 90_000 });
    notes.push('冷启动 argv 深链走通：未知 ID 给出了明确错误（02 §8 规则 3）');
    notes.push('（这一条是 Windows / Linux 形状的冷启动；macOS 的冷启动走 open-url，见第 ⑦ 段）');
  } catch (error) {
    problems.push(`冷启动深链没走通：${String(error).slice(0, 300)}`);
  } finally {
    await app?.close().catch(() => undefined);
    removeE2EHome(deepHome);
  }
}

// ── ⑦ 深链的系统派发：协议注册 · macOS open-url · 单实例锁 ─────────────
/*
 * **这一段让系统参与，所以它验得到第 ⑥ 段验不到的那三样。**
 *
 *   · 协议注册问的是 **LaunchServices 自己的注册表**，不是我们以为注册成功了
 *   · 在 macOS 上处理它的是 `open-url` 事件（argv 那条只在 Windows / Linux 上走）
 *   · 第二个实例用**同一个** `--user-data-dir` 起来，必然撞上单实例锁（锁按 userData 算）
 *
 * 2026-09-27 之前这三样在代码里就是断的：`electron-entry.mjs` 的端口里
 * **一项都没提供**（`setAsDefaultProtocolClient` / `onOpenUrl` / `onSecondInstance`），
 * 而 bootstrap 用 `?.` 调它们 —— 漏填不报错、不打日志，只是深链静默地不工作。
 * `apps/desktop/test/electron-entry-port.test.ts` 守着"别再漏"，这一段则是
 * **唯一一处见过它们真的工作**的证据。
 *
 * 两条探针用**不同的深链类型**，因为它们的拒绝文案不同 ——
 * 都用 `task/` 的话，第二条会被第一条留在屏幕上的那句话直接满足，等于没断。
 *
 * **副作用，如实说**：应用启动时会把自己注册成 `evowork://` 的处理者
 * （`setAsDefaultProtocolClient`，产品每次启动都做，不是这个脚本额外干的），
 * 所以跑完之后这台机器上的 `evowork://` 指向 dist 里的这个构建。
 */
if (existsSync(exe) && problems.length === 0) {
  const { ELECTRON_RUN_AS_NODE: _drop3, ...env } = process.env;
  const shared = mkdtempSync(join(tmpdir(), 'evowork-pkg-dispatch-'));
  const chromium = join(shared, 'chromium');
  const homeB = join(shared, 'home-second');
  let app;
  try {
    app = await electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${chromium}`],
      env: { ...env, EVOWORK_HOME: join(shared, 'home-first') },
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '欢迎使用 EvoWork' }).waitFor({ timeout: 90_000 });

    /*
     * ⑦a **协议注册**：问 LaunchServices 它认不认这个 bundle。
     *
     * **这里不用 `open evowork://` 来验，原因是实测出来的。** Playwright 是直接 exec
     * `Contents/MacOS/EvoWork` 起的进程，不是经 LaunchServices 启动的。那种情况下
     * `open` 退出码 0、不新起进程，而运行中的实例**收不到** `open-url`
     * （2026-09-27 连看 25 秒，一次都没到；进程数 1 → 1，用户真实家目录也没被动过）。
     *
     * 要让它到，得让 LaunchServices 自己把应用拉起来 —— 而那条路没法把 `EVOWORK_HOME`
     * 传进去（`open` 不传调用方的环境变量），于是测试就会跑在**用户真实的数据**上。
     * 用 `launchctl setenv` 绕过去技术上可行，但那是会话级的全局改动：脚本中途崩掉
     * 就会把用户自己的 EvoWork 指到一个临时目录，下次打开像是数据全没了。
     * 那个代价远大于这条断言的价值。
     *
     * 所以这一段验的是**注册那一半**：`CFBundleURLTypes`（第 ③ 段）加上
     * `setAsDefaultProtocolClient` 真的让系统把这个 bundle 记成了 `evowork:` 的处理者。
     * **派发那一半验不到**，下面如实登记，不混成一句"深链验过了"。
     */
    const lsregister =
      '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Support/lsregister';
    const dump = spawnSync(lsregister, ['-dump'], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
    const lines = (dump.stdout ?? '').split('\n');
    const isPathLine = (line) => line.trimStart().startsWith('path:');
    const at = lines.findIndex((line) => isPathLine(line) && line.includes(appPath));
    /*
     * 往后找而不是全局搜 `evowork:`：全局搜会被**任何**一条记录满足，
     * 包括别处的旧副本 —— 那样这条断言就不再是在说"这个包"了。
     *
     * **窗口由下一条 `path:` 划定，不能写一个固定行数。** 第一版写的是 `at + 80`，
     * 而实测这条记录里 `claimed schemes:` 在 `path:` **之后 105 行** ——
     * 于是断言红了，报的是"系统没把这个包记成处理者"，而系统其实记了。
     * 一个猜出来的窗口给出的是**假阴性**：它看起来在验产品，实际在验我猜得准不准。
     */
    const next = lines.findIndex((line, i) => i > at && isPathLine(line));
    const record = at >= 0 ? lines.slice(at, next > at ? next : lines.length).join('\n') : '';
    check(at >= 0, `LaunchServices 里没有这个包的登记：${appPath} —— 系统根本不知道它存在`);
    check(
      /claimed schemes:.*\bevowork:/.test(record),
      '系统没把这个包记成 evowork: 的处理者 —— Info.plist 的 CFBundleURLTypes 或者' +
        '真入口里的 setAsDefaultProtocolClient 有一边没生效',
    );
    if (at >= 0 && /claimed schemes:.*\bevowork:/.test(record)) {
      notes.push('LaunchServices 认这个包是 evowork: 的处理者（协议注册这一半成立）');
    }
    notes.push(
      'macOS `open-url` 的**派发**这一段验不到 —— 直接 exec 起的进程收不到它，' +
        '而经 LaunchServices 启动就没法隔离 EVOWORK_HOME（理由写在代码注释里）',
    );

    // ⑦b 单实例锁：同一个 user-data-dir 起第二次
    /*
     * **判据是两半，缺一不可。**
     *   · 只断"第二个进程退了"：各跑各的**也会**退（它自己跑完就退了），等于没断
     *   · 只断"第一个窗口收到了"：证明不了第二个进程没在开库
     *
     * 第二半用的是"它的家目录到现在还是空的"：第二个实例拿到的 `EVOWORK_HOME` 是一个
     * **全新目录**，锁真的拦住了它，那个目录就永远不会被建出来。锁没拦住的话，
     * 它会一路走到开 sqlite、起网关 —— 目录立刻就在了。这比去查第一个进程的库干净得多。
     */
    const second = spawnSync(exe, [`--user-data-dir=${chromium}`, 'evowork://library/nod_second'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...env, EVOWORK_HOME: homeB },
    });
    check(
      second.status === 0,
      `第二个实例没有干净退出（status=${second.status}, signal=${second.signal}）——` +
        '单实例锁没生效的表现就是它变成一个完整的应用，一直不退',
    );
    check(
      !existsSync(homeB),
      `第二个实例建出了自己的家目录 ${homeB} —— 它走到了开库那一步，锁没拦住它`,
    );
    try {
      await page.getByText('该文件不在这台电脑上。').waitFor({ timeout: 30_000 });
      notes.push('单实例锁生效：第二个实例把 argv 递给了第一个，自己在开库之前就退了');
    } catch {
      problems.push('第二个实例退了，但第一个窗口没收到它的深链 —— argv 没有被递过去');
    }
  } catch (error) {
    problems.push(`深链的系统派发没走通：${String(error).slice(0, 300)}`);
  } finally {
    await app?.close().catch(() => undefined);
    removeE2EHome(shared);
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
