/**
 * **跑 UI 测试期间不许 Mac 进空闲睡眠。**
 *
 * 2026-10-04 MiMo 验收那一轮，A3 在 30 秒处红了：内核报
 * `stream disconnected before completion: Transport error: network error: error decoding response body`，
 * 同一秒 Playwright 报 `Target page … has been closed`，网关一行日志都没留。
 * `pmset -g log` 对上了：07:07:17 屏幕关，07:07:22 `Entering Sleep state due to 'Idle Sleep'`
 * （用电池，空闲 1 分钟就睡）。真模型一轮要一个小时，没人看着，机器每隔几分钟睡一次。
 * status.md 里 2026-09-29/30 那三次「App 在用例中途自己关掉」大概率是同一件事。
 *
 * `caffeinate -i -w <pid>` 只挡**空闲系统睡眠**（屏幕照样可以关），随 runner 进程退出而解除，
 * runner 被杀也不会留下一个一直阻止睡眠的孤儿。非 macOS 什么都不做。
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export default function globalSetup() {
  if (platform() !== 'darwin') return;
  const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (error) => {
    // 拿不到也照跑，但要说出来：睡过去的用例会以「没真正跑起来」的样子红掉
    console.warn(`[global-setup] caffeinate 起不来（${error.message}），机器空闲时可能睡过去`);
  });
  child.unref();
  return () => child.kill();
}
