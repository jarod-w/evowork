/**
 * 渲染进程入口。
 *
 * 桥不在时**显式说明**而不是白屏：这种情况只会出现在 preload 没加载成功时，
 * 而白屏会让人以为是应用崩了，去看主进程日志 —— 实际要看的是 preload 路径。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { TOKENS_CSS } from '@evowork/tokens';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root —— index.html 被改坏了');

// hiddenInset 下 macOS 交通灯浮在页面内容上。只给 macOS 标记，CSS 才能为它留位；
// Windows / Linux 使用系统标题栏，不应平白把品牌名向右推。
document.documentElement.dataset.platform =
  navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh')
    ? 'macos'
    : 'other';

// token 由 packages/tokens 生成后注入，避免手写一份 CSS 变量与 TS 常量分叉
const style = document.createElement('style');
style.textContent = TOKENS_CSS;
document.head.append(style);

const bridge = window.evowork;
createRoot(root).render(
  <StrictMode>
    {bridge ? (
      <App bridge={bridge} />
    ) : (
      <p className="ew-config-notice">
        没有连上本机服务（preload 未加载）。应用无法工作，请重新启动 EvoWork。
      </p>
    )}
  </StrictMode>,
);
