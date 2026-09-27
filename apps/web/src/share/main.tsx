/**
 * 分享页的入口。**独立 bundle**，与账号应用零共享代码（11 §13.10 C 第 1 条）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { TOKENS_CSS } from '@evowork/tokens';

import { SharePage } from './page.js';
import './share.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root');

const style = document.createElement('style');
style.textContent = TOKENS_CSS;
document.head.append(style);

createRoot(root).render(
  <StrictMode>
    <SharePage />
  </StrictMode>,
);
