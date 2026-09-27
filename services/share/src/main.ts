#!/usr/bin/env node
/**
 * 分享托管服务的进程入口。启动逻辑在 `start.ts`（为了能在进程内测），这里只管
 * 日志写到哪、退出码是几。
 *
 * 它**不与 identity 同进程**：identity 的 DDL 被测试守着不许有内容列，
 * 而这里存的就是文件字节。两个进程 = 两套库 = 那条对外承诺在结构上成立。
 */
import { createLogger, jsonLinesSink } from '@evowork/logging';

import { start } from './start.js';

const logger = createLogger({
  service: 'share',
  level: 'info',
  onViolation: 'drop',
  sink: jsonLinesSink((line) => process.stdout.write(`${line}\n`)),
});

// 体检不过**必须**非 0 退出：systemd 的 `Restart=on-failure` 与监控都认这个，
// 0 会被当成"正常结束"，服务就安静地停在 inactive 上
if (!start(process.env, logger)) process.exitCode = 1;
