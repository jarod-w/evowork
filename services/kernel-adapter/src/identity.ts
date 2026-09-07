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
 * 时会去 `cat` 那份 SKILL.md。按名字关掉；其它系统技能不动。
 */
export const DISABLE_OPENAI_DOCS_CONFIG: Readonly<Record<string, unknown>> = {
  'skills.config': [{ name: 'openai-docs', enabled: false }],
};
