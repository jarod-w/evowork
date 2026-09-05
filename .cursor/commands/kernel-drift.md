---
description: Re-check kernel drift assertions F1–F16
---

Run `node scripts/kernel-drift.mjs` (add `--no-fetch` if the network or `../codex` fetch should not run).

Interpret the script's own output:

- `OK` — assertion still holds and the line number did not move
- `LINE-MOVED` — still holds, line drifted; update `docs/design/README.md` §4 and `scripts/kernel-assertions.json` together
- `BROKEN` — the design document's claim may have been overturned by upstream; do not silently rewrite the assertion to match new code

Do not treat a green `pnpm run check` as a substitute for this; the gate does not clone `../codex`.
