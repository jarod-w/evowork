import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { startWindowsEgressSampler } from '../../apps/desktop/test/e2e/harness/windows-egress.mjs';

it.runIf(process.platform === 'win32')(
  'Windows 采样实际子进程 TCP 连接，并按宿主提供的 PID 归属',
  async () => {
    let response,
      child,
      sampler,
      stopped = false;
    let accepted;
    const requestReady = new Promise((resolve) => {
      accepted = resolve;
    });
    const server = createServer((_request, res) => {
      response = res;
      res.writeHead(200);
      res.write('hold');
      accepted();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      child = spawn(
        process.execPath,
        [
          '-e',
          "require('node:http').get(process.argv[1], r => r.resume());",
          `http://127.0.0.1:${port}`,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      await requestReady;
      sampler = startWindowsEgressSampler(process.pid, { gatewayPid: child.pid });
      await sampler.ready;
      const result = await sampler.stop();
      stopped = true;
      const remote = `127.0.0.1:${port}`;
      expect(result.samples).toBeGreaterThan(0);
      expect(result.remotes).toContain(remote);
      expect(result.owners[remote]).toContain(`gateway · pid ${child.pid}`);
    } finally {
      if (sampler && !stopped) await sampler.stop().catch(() => undefined);
      child?.kill();
      response?.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
  30_000,
);
