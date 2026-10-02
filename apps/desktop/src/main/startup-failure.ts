/**
 * 启动失败时给用户看的那句话。
 *
 * 在此之前，任何启动失败的唯一出口是 `electron-entry.mjs` 里的
 * `console.error` + `app.exit(1)`：打包后的应用**一闪就没了**，没有任何说明。
 * 对「代码写错了」这算响亮（stderr 上有），对用户来说和「点了没反应」没有区别。
 *
 * 这里只认**用户能自己处理**的那几类失败 —— 认出来就给出能照做的一句话，
 * 认不出来返回 undefined、维持原来的退出路径。不把任意异常的 `message` 塞给用户：
 * 那些是写给开发者的（`AuthoritativeMigrationFailed` 的文案里有备份路径与设计文档章节号）。
 *
 * 不 import electron，所以能单测；弹框本身在 `bootstrap.ts` 经 `ElectronApi.showErrorBox`。
 */
import { SchemaNewerThanApp } from '@evowork/store';

export interface StartupFailureNotice {
  readonly title: string;
  readonly body: string;
}

export function describeStartupFailure(
  error: unknown,
  appVersion: string,
): StartupFailureNotice | undefined {
  if (error instanceof SchemaNewerThanApp) {
    const install = error.writtenBy
      ? `请安装 EvoWork ${error.writtenBy} 或更新的版本后再打开。`
      : '请安装最新版本的 EvoWork 后再打开。';
    return {
      title: 'EvoWork 无法打开',
      body:
        `这台电脑上的 EvoWork 数据来自更新的版本，当前安装的 ${appVersion} 无法读取它。\n\n` +
        `${install}\n\n` +
        '为了不损坏数据（包括定时任务和分享记录），这次没有做任何改动。',
    };
  }
  return undefined;
}
