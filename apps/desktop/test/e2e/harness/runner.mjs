/**
 * 真窗口 E2E 的**运行器协议**：阶段标记、结果标记、轮询等待、给进程外驱动用的控制面。
 *
 * 外层脚本（`scripts/desktop-skills-e2e.mjs` · `scripts/verify-agent-loop.mjs`）只认 stdout
 * 上的两种标记：阶段标记让「卡住了」能说清卡在哪一步，结果标记是**唯一**的验收口径。
 * 前缀是这两侧之间的契约，改一个字两边就对不上 —— 所以由调用方显式传进来，
 * 这里不替它拼一个「看起来对」的名字。
 */

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
