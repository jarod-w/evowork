/**
 * **随包技能的契约**：`plugins/skills/` 里每一个都得真的能被用起来。
 *
 * 这一层此前没有测试。而它的失败形状全是**静默的**：
 *   · SKILL.md 的 `name` 与目录名不一致 → `$技能名` 引用解析不到，界面上只是"没反应"；
 *   · `description` 为空 → 内核靠它决定什么时候调这个技能，空的等于它永远不会被选中；
 *   · `interface.json` 写坏（哪怕只是把 `displayName` 拼成 `display_name`）→
 *     `parseInterfaceJson` **静默回退**到 `{ displayName: id, category: '未分类' }`，
 *     插件目录里显示的就是原始目录名，而任何一层都不报错。
 *
 * 所以下面断言的不是"文件存在"，而是**那些字段真的被采纳了**。
 *
 * 这些是静态契约。"内核真的发现了它们"由 `apps/desktop/test/e2e/skill-reference.e2e.mjs`
 * 用真 app-server 验 —— 两边缺一不可：静态过了不代表内核认，内核认了不代表界面显示得对。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseFrontmatter, parseInterfaceJson } from '../src/skills.js';
import type { SkillInterface } from '../src/types.js';

const SKILLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../plugins/skills');

/**
 * 随包技能的清单。**写死一份**，这样悄悄增删会红。
 *
 * `_shared` 不是技能，是四个办公技能共用的运行时（`evowork_skill.py` / `mark_artifact.mjs`）。
 */
const EXPECTED = [
  'charts',
  'computer-use',
  'documents',
  'presentations',
  'skill-creator',
  'spreadsheets',
  'ui-design',
] as const;

const dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== '_shared' && !e.name.startsWith('.'))
  .map((e) => e.name)
  .sort();

describe('随包技能的清单', () => {
  it('目录与清单逐项相等 —— 增删技能必须是显式的', () => {
    expect(dirs).toEqual([...EXPECTED]);
  });
});

describe.each(dirs)('随包技能：%s', (name) => {
  const dir = join(SKILLS_ROOT, name);
  const skillMd = join(dir, 'SKILL.md');

  it('有 SKILL.md —— 没有它，内核根本不会把这个目录当成技能', () => {
    expect(existsSync(skillMd), `${name} 缺 SKILL.md`).toBe(true);
  });

  it('frontmatter 的 name 等于目录名 —— 不等的话 `$name` 引用解析不到', () => {
    const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'));
    expect(fm.name, `${name}/SKILL.md 的 name 是 ${JSON.stringify(fm.name)}`).toBe(name);
  });

  /**
   * `description` 是内核**决定什么时候调用这个技能**的唯一依据。
   * 空的不会报错 —— 这个技能只是从此不会被自动选中，而那看起来和"模型不够聪明"一模一样。
   */
  it('description 非空，且不是把名字重复一遍', () => {
    const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'));
    expect(fm.description.trim().length, `${name} 的 description 是空的`).toBeGreaterThan(20);
    expect(fm.description.trim().toLowerCase()).not.toBe(name);
  });

  /**
   * **interface.json 要真的被采纳，不能静默回退。**
   *
   * `parseInterfaceJson` 对任何坏输入都回退到 `{ displayName: id, category: '未分类' }`
   * —— 不抛错、不记日志。所以这里不看"文件在不在"，看**解析结果是不是还等于兜底值**：
   * 等于兜底就说明那个文件白带了。
   */
  /**
   * 13 §5.5（HUB-Q7=A）：Hub 可以发布随包技能的新版本，**版本高的生效**。随包这份不写版本时
   * 按 `0.0.0` 算 —— 任何 Hub 版本都比它新，App 升级后随包那份修好了也回不来。
   * 所以每个随包技能都要写一个认得出来的版本号；改了随包技能的行为，就把它调高。
   */
  it('interface.json 写了版本号（Hub 覆盖随包技能时靠它比新旧）', () => {
    const raw = JSON.parse(readFileSync(join(dir, 'interface.json'), 'utf8')) as {
      version?: unknown;
    };
    expect(typeof raw.version === 'string' && /^\d+\.\d+\.\d+$/.test(raw.version), name).toBe(true);
  });

  it('interface.json 真的被采纳（displayName 与 category 都不是兜底值）', () => {
    const fallback: SkillInterface = { displayName: name, category: '未分类' };
    const text = existsSync(join(dir, 'interface.json'))
      ? readFileSync(join(dir, 'interface.json'), 'utf8')
      : undefined;
    const iface = parseInterfaceJson(text, fallback);

    expect(iface.displayName, `${name} 的 displayName 回退成了目录名`).not.toBe(name);
    expect(iface.category, `${name} 的 category 回退成了「未分类」`).not.toBe('未分类');
  });
});
