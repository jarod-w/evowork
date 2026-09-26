/**
 * 「上游多久没动静算它死了」—— 两条上游共用的一套判据。
 *
 * 网关有两条上游：本机直连厂商（`pipeline.ts`）与转发到云端网关（`server.ts` 的
 * `pipeForward`）。它们的失败形态完全一样 —— **连接还开着，但再也不来字节** ——
 * 而内核那边看到的症状也完全一样：300 秒没帧就判整个回合失败。
 *
 * 之所以把判据抽出来而不是各写一份：2026-09-26 补心跳时只给了前者看门狗，
 * 后者靠内核的 300 秒兜底。心跳一上，那个兜底就没了 —— 转发路径变成
 * **永远不超时**（心跳一直跳、回合一直转）。一条"修好了这边、顺手拆了那边的保险"
 * 的缺陷，根因是两条路各写各的。
 */

/** 看门狗赢了这一轮的标记。用 Symbol 是为了与"上游真的回了东西"彻底分开。 */
export const STALLED = Symbol('upstream-idle');

/**
 * 上游**两片之间**最多允许安静多久。超过就判这条流已经死了。
 *
 * 流动起来之后的两分钟空档只意味着连接死了 —— 没有哪家厂商会在吐字中途停两分钟。
 */
export const DEFAULT_UPSTREAM_IDLE_MS = 120_000;

/**
 * 拿到响应（头）之后、**第一片**到达之前的等待上限。
 *
 * 与上一项分开，是因为量级本来就不同：首片要等上游读完整个上下文
 * （长上下文 + 思考模型能到分钟级）。给首片一个更松的预算，是为了不把
 * "本来会成功的慢回合"改成失败 —— 修超时缺陷时最容易顺手造出来的正是这种回归。
 */
export const DEFAULT_FIRST_CHUNK_MS = 300_000;

/**
 * 等这一片，但最多等 `ms`。超时返回 `STALLED`，**不取消 `pending`** ——
 * 怎么收拾（掐上游、接住随后的拒绝）由调用方决定，因为两条上游的收尾动作不同。
 *
 * `ms <= 0` 表示不看门，此时直接等。
 */
export async function raceIdle<T>(pending: Promise<T>, ms: number): Promise<T | typeof STALLED> {
  if (ms <= 0) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof STALLED>((resolve) => {
        timer = setTimeout(() => resolve(STALLED), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    // 上游正常回了这一片时也要停表，否则一个长回合会攒下成千上万个定时器
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 看门狗掐断时给用户的话。两条上游只有主语不同，别各写各的。 */
export function stalledMessage(source: '模型服务' | '云端网关', budgetMs: number): string {
  return (
    `${source}已有 ${Math.round(budgetMs / 1000)} 秒没有返回任何内容，这次请求已中断。` +
    `可以点「重试」再来一次，或到设置里换一个模型。`
  );
}
