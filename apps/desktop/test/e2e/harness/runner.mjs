import { rmSync } from 'node:fs';

/**
 * 真窗口 E2E 的**运行器协议**：阶段标记、结果标记、轮询等待、给进程外驱动用的控制面。
 *
 * 外层脚本（`scripts/desktop-skills-e2e.mjs` · `scripts/verify-agent-loop.mjs`）只认 stdout
 * 上的两种标记：阶段标记让「卡住了」能说清卡在哪一步，结果标记是**唯一**的验收口径。
 * 前缀是这两侧之间的契约，改一个字两边就对不上 —— 所以由调用方显式传进来，
 * 这里不替它拼一个「看起来对」的名字。
 */

/**
 * 跑完把一次性 home 删掉。
 *
 * 不删的代价是实测出来的：一次会话在 `/var/folders` 下攒了 **4.8 GB**
 * （每个 home 里有内核家目录、本机 sqlite、rollout 与解析缓存），而那个目录没人会去看。
 *
 * **失败时不要调它** —— 那份 home 是排查"为什么这条红了"的唯一依据，
 * 与 Playwright 失败时保留 trace 是同一个道理。
 *
 * 放在这个文件而不是 `boot.mjs`：夹具跑在**普通 Node** 里，而 `boot.mjs` import 了
 * `electron` —— 从那边引会让整个 spec 收集阶段炸掉（实测踩到）。这个文件不碰 electron。
 */
export function removeE2EHome(home) {
  if (typeof home !== 'string' || !home.includes('evowork-')) return; // 防手滑
  /*
   * **清理失败绝不能让通过的运行变红。**
   *
   * 2026-09-27 实测：内核子进程刚被停掉那一瞬，它还在往 rollout 里写，
   * `rmSync` 于是抛 `ENOTEMPTY` —— 全部断言都过了，测试却红在收尾上。
   * 那是最坏的一种红：它指向的地方与真正的问题毫无关系。
   *
   * 所以重试一次（给还没落下的写操作一点时间），仍然失败就只是少收拾一个目录，
   * 说一声，不影响结论。
   */
  for (const attempt of [0, 1]) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 1) {
        console.warn(`[e2e] 没能清掉临时目录 ${home}：${String(error)}`);
        return;
      }
      // 同步等一小会儿：这里在进程退出前的收尾路径上，不能 await
      const until = Date.now() + 300;
      while (Date.now() < until) {
        /* 自旋 */
      }
    }
  }
}

/** 阶段与结果标记的写出口。两个入口各有一套前缀，不能共用。 */
export function createRunner({ stagePrefix, resultPrefix }) {
  if (!stagePrefix || !resultPrefix) throw new Error('E2E 运行器缺少标记前缀。');
  return {
    stage(message) {
      process.stdout.write(`${stagePrefix}${message}\n`);
    },
    report(payload) {
      process.stdout.write(`${resultPrefix}${JSON.stringify(payload)}\n`);
    },
  };
}

/**
 * 轮询到条件成立为止。
 *
 * `check` 抛错一律当成「还没到」：内核重启与窗口导航都有短暂空窗，而那两段恰恰是
 * E2E 最需要等的地方。只有超时才报错，报的是调用方写的那句话 —— 所以那句话要写
 * **等不到意味着什么**（CLAUDE.md §9.1「断言写后果」），不是「超时了」。
 */
export function waitFor(check, message, timeoutMs = 15_000, pollMs = 50) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {
        // 空窗期：留给下一拍
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(message));
      setTimeout(poll, pollMs);
    };
    void poll();
  });
}

/**
 * 把控制面挂到 `globalThis`，给**进程外**的驱动用。
 *
 * 目前没有进程外驱动，所以这里只是「挂上去」；它存在的理由是第 2 步：
 * 换 Playwright 之后驱动跑在 Electron 进程之外，`electronApp.evaluate()` 在主进程里求值,
 * 够得着 `globalThis`，够不着这些模块的闭包。而「杀内核」「让网关这一次挂住」这类动作
 * 只有主进程做得到 —— 不从这里露出去，第 2 步就只能把它们重写一遍。
 */
export function publishControls(controls) {
  globalThis.__evoworkE2E = { ...globalThis.__evoworkE2E, ...controls };
  return globalThis.__evoworkE2E;
}
