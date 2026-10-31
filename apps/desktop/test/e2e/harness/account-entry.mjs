/** 真实入口的只读验收探针：记录公开浏览器 URL 与令牌摘要，不替代账号或网关实现。 */
import { app, shell } from 'electron';
import { createHash } from 'node:crypto';

app.setPath('userData', process.env.EVOWORK_ACCOUNT_TEST_PROFILE);
globalThis.__accountEvidence = { urls: [], renewals: [] };
shell.openExternal = async (url) => {
  globalThis.__accountEvidence.urls.push(url);
};
const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await networkFetch(input, init);
  if (String(input).endsWith('/v1/oauth/token') && response.ok) {
    const body = await response.clone().json();
    const request = JSON.parse(init?.body ?? '{}');
    globalThis.__accountEvidence.renewals.push({
      at: Date.now(),
      grant: request.grant_type,
      accessDigest: createHash('sha256').update(body.accessToken).digest('hex'),
      refreshDigest: createHash('sha256').update(body.refreshToken).digest('hex'),
    });
  }
  return response;
};
await import('../../../dist/main/electron-entry.mjs');
