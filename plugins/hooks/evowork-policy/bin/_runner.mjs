/**
 * 四个 hook 脚本共用的运行器。
 *
 * ## 它怎么找到策略实现
 *
 * 打包时（M9）`@evowork/policy` 的构建产物会被放到 `../vendor/policy.mjs`；
 * 开发时退回仓库里的 `services/policy/dist/index.js`（`pnpm typecheck` 会产出它）。
 * 两条都找不到时**放行并在 stderr 说明**，而不是拦住工具 ——
 * 一个可观测性/策略组件装错了不该让用户的任务跑不动。
 *
 * 唯一的例外是**硬拦截**：它是安全边界，找不到实现时应当保守。
 * 但"找不到实现"意味着我们也不知道该拦什么，拦住一切等于产品不可用。
 * 所以这里的选择是：放行 + 大声报错（stderr 会进内核日志），
 * 而真正的兜底在沙箱层（M4 的 seatbelt / landlock），不在这个 hook 上。
 */
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  join(HERE, '..', 'vendor', 'policy.mjs'),
  resolve(HERE, '../../../../services/policy/dist/index.js'),
];

async function loadPolicy() {
  for (const candidate of CANDIDATES) {
    try {
      return await import(candidate);
    } catch {
      /* 下一个 */
    }
  }
  return undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export async function runHook(handlerName) {
  const policy = await loadPolicy();
  if (!policy) {
    process.stderr.write(
      'evowork-policy: 找不到策略实现，本次放行。请检查安装是否完整（见 bin/_runner.mjs 的头注释）。\n',
    );
    return;
  }

  const input = await readStdin();
  const env = { home: homedir(), now: () => Date.now() };
  const { output, audit } = policy[handlerName](input, env);

  const auditPath = process.env.EVOWORK_AUDIT_LOG;
  if (auditPath) {
    for (const record of audit) {
      try {
        // 同步追加：hook 进程马上退出，异步写有丢的风险
        appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
      } catch {
        /* 审计写不进去不能挡住工具执行 */
      }
    }
  }

  process.stdout.write(policy.serialize(output));
}
