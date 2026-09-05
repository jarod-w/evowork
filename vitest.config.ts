import { defineConfig } from 'vitest/config';

/**
 * 单一入口跑全仓库测试。
 *
 * projects 指向**配置文件**而不是目录：目录 glob 会把还没有测试的占位目录也当成 project
 * 并试图加载它的 README，报一个与测试无关的 esbuild 错。指向配置文件后，
 * "有 vitest.config.ts 的包才被跑"这件事是自解释的。
 */
export default defineConfig({
  test: {
    projects: [
      'scripts/vitest.config.ts',
      'tools/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'services/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'plugins/skills/*/vitest.config.ts',
    ],
  },
});
