---
description: Run the repo gate (pnpm run check)
---

Run `pnpm run check` from the repository root. It is the only acceptance gate: Prettier, ESLint (including the K2 boundary rule and token-only styles), TypeScript (including tests), Vitest, and the K1 patch budget.

Do not treat `pnpm exec vitest run` on a single package, or `tsc` without the repo `typecheck` script, as done.

If Node or pnpm is missing, say so; this repo has no silent frontend skip switch.
