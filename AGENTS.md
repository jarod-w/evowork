# Agent instructions

Cross-session rules: [`CLAUDE.md`](CLAUDE.md).
Cursor always-on body: [`.cursorrules`](.cursorrules) (loaded for Agent mode via [`.cursor/rules/00-core.mdc`](.cursor/rules/00-core.mdc)).
Path-scoped Cursor rules: [`.cursor/rules/`](.cursor/rules/).
Current facts: [`docs/status.md`](docs/status.md). Read it before changing code.

These files describe the same contract. Do not add a stronger guarantee in one of them that the others do not support.

Version preparation and release notes: follow [CLAUDE.md](CLAUDE.md#版本准备与更新说明)
and [the release preparation workflow](docs/build-and-deploy.md#用-git-记录准备下一版).
Use `pnpm run release:prepare -- <version> [--dry-run]` from a clean working tree;
review the generated draft and keep both release-note files in sync before publishing.
Changing release tooling alone does not imply bumping the product version or publishing.
