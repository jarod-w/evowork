/**
 * 真装一遍（下载 + pip + 字体 + 验收），装到一个临时 HOME 里。
 *
 * ## 为什么它是可选的，以及为什么这不是 CLAUDE.md §9.1 说的那种坏跳过
 *
 * §9.1 反对的是 `skipIf(装了扩展)` 那种**按机器状态跳过**的写法：在装了扩展的机器上，
 * "没装时怎么办"永远没人验，而那恰恰是用户第一次用时走的路径。
 *
 * 这一条不同：它按**显式意图**开关（`EVOWORK_INSTALL_E2E=1`），而且每次跑都在一个
 * 全新的临时 HOME 上从零装 —— 它验的就是干净机器。默认不跑只是因为它要下 ~180MB、
 * 耗时几分钟，放进 `pnpm run check` 会让每次提交都去拖一遍 GitHub 和 PyPI。
 *
 * 上游资产变了（清单过期、GitHub 改布局）只有这条能发现，所以**发版前必须跑它**：
 * ```bash
 * EVOWORK_INSTALL_E2E=1 npx vitest run --project runtime-installer
 * ```
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installOfficeRuntime, officeRoot, type InstallProgress } from '../src/install.js';
import { FONT_FAMILY, FONT_FILE_NAME, REQUIREMENTS } from '../src/manifest.js';

const enabled = process.env.EVOWORK_INSTALL_E2E === '1';

describe.runIf(enabled)('真机安装（EVOWORK_INSTALL_E2E=1 才跑）', () => {
  it(
    '干净 HOME 上从零装出一个能用的办公扩展',
    // 15 分钟：慢网上下 110MB 的 linux 运行时再 pip 装六个包，分钟级是正常的。
    // 真卡住由 `downloadAsset` 的停滞看门狗兜（60 秒没数据就失败），不靠这个超时
    { timeout: 15 * 60 * 1000 },
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'evowork-e2e-'));
      const phases: InstallProgress[] = [];
      try {
        const result = await installOfficeRuntime({
          home,
          onProgress: (p) => {
            phases.push(p);
            /*
             * 阶段变化打到 stderr。**这不是调试残留**：这个测试跑起来要几分钟，
             * 没有这行的话它超时的时候只能看到"超时了"，看不出卡在下载还是卡在 pip ——
             * 2026-09-07 第一次跑它就是这么卡的，而当时无从判断该往哪儿查。
             */
            if (phases.at(-2)?.phase !== p.phase) {
              process.stderr.write(`  [e2e] ${p.phase} ${p.percent}% ${p.detail ?? ''}\n`);
            }
          },
        });

        expect(result.ok, result.ok ? '' : `安装失败：${result.message}`).toBe(true);
        if (!result.ok) return;

        /* ① 解释器真的能跑 */
        const version = execFileSync(result.interpreter, ['-V'], { encoding: 'utf8' });
        expect(version).toContain('Python 3.12');

        /* ② 六个包都 import 得动 —— 探针与四个技能查的就是这些 */
        const modules = 'import docx, openpyxl, pptx, pdfplumber, matplotlib, jsonschema';
        expect(() =>
          execFileSync(result.interpreter, ['-c', modules], { stdio: 'pipe' }),
        ).not.toThrow();
        expect(REQUIREMENTS.length).toBe(6);

        /* ③ 字体在，且 matplotlib 认得出家族名（charts 就是这么找的） */
        const font = join(officeRoot(home), 'fonts', FONT_FILE_NAME);
        expect(existsSync(font)).toBe(true);
        const script = [
          'import matplotlib; matplotlib.use("Agg")',
          'from matplotlib import font_manager',
          `font_manager.fontManager.addfont(${JSON.stringify(font)})`,
          `print(${JSON.stringify(FONT_FAMILY)} in {f.name for f in font_manager.fontManager.ttflist})`,
        ].join('\n');
        const seen = execFileSync(result.interpreter, ['-c', script], { encoding: 'utf8' });
        expect(seen.trim()).toBe('True');

        /*
         * ④ **可搬运** —— 这是整件事的关键性质，所以直接把它搬一次再跑。
         *
         * 别去断言"解释器不是符号链接"：`bin/python3` 确实是符号链接，但它指向
         * 同目录下的 `python3.12`（**相对**链接），搬到哪儿都成立。
         * uv venv 坏掉的原因不是"有符号链接"，而是那个链接是**绝对路径、指向树外**
         * （`~/.local/share/uv/python/...`）—— 客户机器上没有那个目标，拷过去就是死链。
         *
         * 分不清这两者的断言会把好设计判成坏的：2026-09-07 第一版就是这么写错的。
         * 搬一次再跑，把"到底能不能搬"直接问出来，没有中间推理。
         */
        const moved = `${officeRoot(home)}-moved`;
        const { rename } = await import('node:fs/promises');
        await rename(officeRoot(home), moved);
        const movedInterpreter = result.interpreter.replace(officeRoot(home), moved);
        const afterMove = execFileSync(movedInterpreter, ['-c', 'import docx; print("ok")'], {
          encoding: 'utf8',
        });
        expect(afterMove.trim(), '换个目录就跑不起来的话，企业离线包与随包分发都不成立').toBe('ok');
        await rename(moved, officeRoot(home));

        /* ⑤ 进度确实走完了 */
        expect(phases.at(-1)?.phase).toBe('done');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

/**
 * 离线安装（企业部署，08 §4.1）。
 *
 * 先用 `node scripts/build-office-bundle.mjs --out <目录>` 打一份，然后：
 * ```bash
 * EVOWORK_INSTALL_E2E=1 EVOWORK_OFFICE_BUNDLE=<目录> npx vitest run --project runtime-installer
 * ```
 *
 * 这条与上面那条**验的不是同一件事**：上面验"能不能从网上装出来"，
 * 这条验"离线包是不是真的够用"。企业机器上不去 GitHub 与 PyPI，
 * 而离线包缺一个 wheel 的表现是在**客户机器上**装到一半失败。
 */
const bundleDir = process.env.EVOWORK_OFFICE_BUNDLE;

describe.runIf(enabled && bundleDir !== undefined)('离线包装得上（企业部署）', () => {
  it('只用离线包就能装出一个能用的办公扩展', { timeout: 10 * 60 * 1000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'evowork-offline-'));
    try {
      const result = await installOfficeRuntime({
        home,
        bundleDir: bundleDir as string,
        /*
         * **把下载函数换成"一被调用就炸"**。
         *
         * 这是这条测试的关键：它不是"碰巧没联网"，而是让任何一次下载都立刻失败。
         * 只要离线路径上还残留一次网络调用，这条就会红 ——
         * 而在企业机器上，那一次调用的表现是安装卡住然后失败。
         */
        downloadFn: (async () => {
          throw new Error('离线安装路径上不该有任何下载');
        }) as unknown as never,
      });

      expect(result.ok, result.ok ? '' : `离线安装失败：${result.message}`).toBe(true);
      if (!result.ok) return;
      expect(result.offline).toBe(true);

      const modules = 'import docx, openpyxl, pptx, pdfplumber, matplotlib, jsonschema';
      expect(() =>
        execFileSync(result.interpreter, ['-c', modules], { stdio: 'pipe' }),
      ).not.toThrow();
      expect(existsSync(join(officeRoot(home), 'fonts', FONT_FILE_NAME))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
