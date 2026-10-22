/**
 * 产品身份（K5）走内核已经提供的覆盖口，不打 P4 补丁。
 *
 * `developer_instructions`（`config/modes/*.md`）只叠加、不替换系统底稿。
 * 2026-09-07 实测：两层都生效时模型会拼出「运行在 Codex CLI 里的执行智能体，
 * 当前处于 Craft」—— 模式对了，产品名仍是内核那句。覆盖必须走
 * `thread/start.baseInstructions`（F25）。
 *
 * `openai-docs` 是内核装进 `skills/.system/` 的系统技能，description 把
 * 「you / this app / this coding agent」绑到 Codex 文档上。用户问「你是什么模型」
 * 时会去 `cat` 那份 SKILL.md。按名字关掉。
 *
 * 2026-10-22 起 `skills/.system/` 整组关掉（`skills.bundled.enabled = false`）：对真实会话复盘，
 * 用户问「你加载了哪些技能」，回答里出现「创建 Codex 插件」「安装到 $CODEX_HOME/skills」；
 * imagegen 与随包 image-generation 抢同一类请求，生图前模型把两份说明都读了一遍。
 * 这里只管回合；`$` 引用列表走 `skills/list`，靠 `config.toml` 那段全局设置
 * （宿主的 `migrateBundledSkillsConfig` 给老安装补上）。回合级这份会压过 `config.toml` 里
 * 显式写的 `true` —— 系统技能的文案带着 Codex 品牌，K5 不留开关。按名字关 openai-docs 那条留着，
 * 它不依赖 bundled 这一个开关。
 */
export const DISABLE_SYSTEM_SKILLS_CONFIG: Readonly<Record<string, unknown>> = {
  'skills.bundled.enabled': false,
  'skills.config': [{ name: 'openai-docs', enabled: false }],
};
