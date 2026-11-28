import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { TOKENS_CSS } from '@evowork/tokens';

import { App } from './app.js';
import './site.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root container');

const style = document.createElement('style');
style.textContent = TOKENS_CSS;
document.head.append(style);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
