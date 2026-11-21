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
import { detectDesktopPlatform } from './platform.js';
import './styles/app.css';
import './styles/skill-extraction.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root —— index.html 被改坏了');

// 01 §3.2：按平台标记窗口形态（macOS 交通灯留白 / Windows titleBarOverlay 一体化顶栏 / 其他系统栏）
document.documentElement.dataset.platform = detectDesktopPlatform();

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
