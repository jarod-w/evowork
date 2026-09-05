/**
 * 向 EvoWork 的**本机 artifacts 服务**上报产物意图（08 §2.2 的信号 ①）。
 *
 * ## 为什么不用内核那个同名机制
 *
 * 内核有 `container_tools/mark_artifact_operation_started.mjs` 的约定，但它的识别结果
 * **只喂 codex_analytics、不进 app-server 协议**，而且硬编码
 * `marketplace_name == "openai-primary-runtime"`（F10 实测）。所以那条链路对我们完全无用，
 * 产物识别 100% 自建（D6 的 v0.4 修订）。
 *
 * 我们**沿用它的参数形状**（`--operation-kind` / `--expected-output-count` / `--output-format`），
 * 这样如果上游哪天把识别结果接进协议，切换成本很低；但**不复用它的 marketplace 名**
 * （K5：不引入 OpenAI 品牌字符串，且那个常量随时可能变）。
 *
 * ## 四个技能共用一份
 *
 * `documents` / `spreadsheets` / `presentations` / `charts` 的上报参数与传输方式完全一样，
 * 各留一份的结果是四份慢慢分叉。所以实现在这里，各技能的
 * `container_tools/mark_artifact.mjs` 只是 `runMarkArtifact('<技能名>')` 一行。
 *
 * 技能名由薄壳传进来而**不是**命令行参数：SKILL.md 里的调用没有 `--skill`，
 * 把它改成必填等于改四份文档，而技能名本来就是"哪个文件在跑"这件事已知的。
 *
 * ## 传输
 *
 * 写一行 JSON 到 `EVOWORK_ARTIFACT_SOCKET` 指向的 unix socket；未设置时退回
 * `EVOWORK_ARTIFACT_LOG` 指向的文件（追加一行）。两者都没有时**静默成功** ——
 * 技能不该因为"产物索引没开"而失败：产物本体已经写到磁盘上了（D6：文件系统是真源），
 * 索引缺一条会由 `FILE_CHANGE` 信号（②）或 hook 扫描（③）补上。
 */
import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';

const ARG_SPEC = {
  '--operation-kind': 'operationKind',
  '--expected-output-count': 'expectedOutputCount',
  '--output-format': 'outputFormat',
  '--title': 'title',
  '--path': 'path',
  '--skill': 'skill',
};

function parseArgs(argv, defaultSkill) {
  const out = { skill: defaultSkill };
  for (let i = 0; i < argv.length; i += 1) {
    const key = ARG_SPEC[argv[i]];
    if (!key) continue;
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

function validate(args) {
  const problems = [];
  if (!['create', 'edit'].includes(args.operationKind)) {
    problems.push('--operation-kind 必须是 create 或 edit');
  }
  if (!args.path || !args.path.startsWith('/')) {
    problems.push('--path 必须是绝对路径（产物本体留在工作空间里，索引只记路径）');
  }
  if (!args.outputFormat) problems.push('--output-format 必填（如 pptx）');
  const count = Number(args.expectedOutputCount ?? '1');
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    problems.push('--expected-output-count 必须是 1–100 的整数');
  }
  return problems;
}

export function runMarkArtifact(defaultSkill) {
  const args = parseArgs(process.argv.slice(2), defaultSkill);
  const problems = validate(args);
  if (problems.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, problems }, null, 0)}\n`);
    process.exit(2);
  }

  const record = {
    kind: 'artifact.mark',
    skill: args.skill,
    operationKind: args.operationKind,
    expectedOutputCount: Number(args.expectedOutputCount ?? '1'),
    outputFormat: args.outputFormat,
    // title 是用户可见的显示名，可与文件名不同（08 §2.4：重命名不改文件名）
    ...(args.title ? { title: args.title } : {}),
    path: args.path,
    at: new Date().toISOString(),
  };

  const line = `${JSON.stringify(record)}\n`;
  const socketPath = process.env.EVOWORK_ARTIFACT_SOCKET;
  const logPath = process.env.EVOWORK_ARTIFACT_LOG;

  function done() {
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  }

  if (socketPath) {
    const socket = connect(socketPath, () => {
      socket.end(line, () => done());
    });
    socket.on('error', () => {
      // 服务没起来不算技能失败（见文件头）——退回文件，再不行就静默成功
      if (logPath) {
        try {
          appendFileSync(logPath, line);
        } catch {
          /* 索引缺一条会被信号 ②/③ 补上 */
        }
      }
      done();
    });
  } else if (logPath) {
    try {
      appendFileSync(logPath, line);
    } catch {
      /* 同上 */
    }
    done();
  } else {
    done();
  }
}
