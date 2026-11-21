/**
 * 发送、选文件夹、添加附件共用一把环境锁。
 *
 * 锁被占着时后来的附件不能丢掉：排上，等这次操作放开后再做。
 * 放开后放到下一轮调用栈，是因为创建目标的命令会在同一轮里接着发送，
 * 同步启动附件会和那次发送抢锁。
 */
export function createWorkQueue<T>() {
  const waiting: T[] = [];
  return {
    push(item: T) {
      waiting.push(item);
    },
    release(isBusy: () => boolean, start: (item: T) => void) {
      const next = waiting.shift();
      if (next === undefined) return;
      setTimeout(() => {
        if (isBusy()) {
          waiting.unshift(next);
          return;
        }
        start(next);
      }, 0);
    },
  };
}
