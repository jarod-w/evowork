#!/usr/bin/env node
/**
 * SessionEnd hook。**只做 I/O**，决策在 `services/policy/src/hooks/handlers.ts` 里。
 * 分开的理由见那个文件的头注释：这几条决策"错了不报错"，必须能被单独测。
 */
import { runHook } from './_runner.mjs';

await runHook('handleSessionEnd');
