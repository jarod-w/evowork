import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = Number(process.env.PORT || 8888);
const host = process.env.HOST || '0.0.0.0';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

function inside(urlPath) {
  let decoded = '/';
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const full = resolve(root, `.${decoded}`);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  return full;
}

function sendFile(res, file) {
  const type = types.get(extname(file)) ?? 'application/octet-stream';
  const cache = extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  });
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end('ok');
    return;
  }
  const full = inside(urlPath);
  if (!full) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (existsSync(full) && statSync(full).isFile()) {
    sendFile(res, full);
    return;
  }
  const ext = extname(urlPath);
  if (ext && ext !== '.html') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dist missing');
    return;
  }
  sendFile(res, index);
}).listen(port, host);
