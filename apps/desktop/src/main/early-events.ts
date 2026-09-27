/**
 * **早到的系统事件的缓冲区。**
 *
 * macOS 会在 `whenReady` **之前**发 `open-url`：用户在应用没开着的时候点一条
 * `evowork://` 分享链接，LaunchServices 把应用拉起来，事件很早就到 ——
 * 而 `bootstrap()` 的第一件事是 `await app.whenReady()`，接线在那之后很远。
 * 不缓冲，那条链接就没了，表现正是这个特性要防的「点了链接什么都没发生」。
 *
 * ## 为什么单独一个文件
 *
 * 这几行原本写在 `electron-entry.mjs` 里，跟 `import 'electron'` 绑死，
 * **一行测试都盖不到** —— 而它恰好是今天坏了两次的那一类逻辑（早到就丢）。
 *
 * 「macOS 会不会早发 `open-url`」是 Apple 的行为，我们验不了也不必验；
 * 「**它早到了我们会不会丢**」是我们的行为，必须能验。所以把能验的这一半拎出来。
 */

export interface EarlyBuffer<T> {
  /** 事件来了。还没接线就先存着，接了线就直接交过去。 */
  readonly push: (value: T) => void;
  /** 接线。**同时把攒下的补发出去**，然后清空。 */
  readonly connect: (handler: (value: T) => void) => void;
}

export function createEarlyBuffer<T>(): EarlyBuffer<T> {
  const early: T[] = [];
  let deliver: ((value: T) => void) | undefined;

  return {
    push: (value) => {
      if (deliver) deliver(value);
      else early.push(value);
    },
    connect: (handler) => {
      deliver = handler;
      /*
       * `splice(0)` 而不是遍历后留着：**补发完必须清空**。
       * 不清的话，第二次 connect（热重载、或者将来多一个消费者）会把旧链接再放一遍 ——
       * 用户看到的是自己没点过的跳转，而且查不出是哪来的。
       */
      for (const value of early.splice(0)) handler(value);
    },
  };
}
