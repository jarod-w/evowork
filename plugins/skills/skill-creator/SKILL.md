---
name: skill-creator
description: Create or update a reusable EvoWork skill in the current project when the user asks to add a repeatable workflow, domain playbook, or tool-backed capability.
---

# Skill Creator

Create the smallest useful skill that preserves the user's intent and authority.

## Destination

Unless the user gives another location, write project-scoped skills to
`<workspace>/.agents/skills/<skill-name>/SKILL.md`. Use a lowercase, hyphenated name under 64
characters. Never write outside the current workspace without explicit approval.

## Workflow

1. Infer the intended tasks, activation boundary, required inputs, outputs, and real safety
   constraints. Ask only for missing information that would materially change the skill.
2. Write concise YAML frontmatter with `name` and a discriminating `description`. Keep the body
   focused on decisions or procedures that the model would not reliably infer on its own.
3. Add `scripts/`, `references/`, or `assets/` only when they provide a concrete reusable benefit.
   Do not create placeholder files, README files, changelogs, or copied manuals.
4. Do not execute scripts copied from the user's sources. New deterministic helper scripts may be
   tested only within the current workspace and within the task's existing permissions.
5. Read back every created instruction file. Verify the folder name, frontmatter, relative links,
   and that no scaffold placeholders remain.
6. Report the exact `SKILL.md` path and a realistic invocation example. EvoWork watches project
   skill roots; if the new skill does not appear after refresh, surface the load error instead of
   claiming installation succeeded.

For updates, preserve unrelated instructions and resources. Do not broaden automatic activation
or external side effects unless the user asked for that change.
