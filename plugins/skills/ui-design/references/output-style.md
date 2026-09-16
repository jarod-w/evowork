# Output Style

Use this guidance for the visible transcript as well as sample content placed in a workbench-style interface.

## Assistant prose

- Lead with the outcome, answer, or current state. Put process detail after it.
- Write like a calm technical collaborator: direct, specific, and easy to scan.
- Prefer a few cohesive paragraphs. Add a short list only when the items are genuinely parallel or actionable.
- Use headers only when they materially help navigation. Avoid stacking a header, summary, and list that repeat one another.
- Use plain language before jargon. Include technical detail when it changes a decision or helps verification.
- State assumptions, uncertainty, and blockers concretely. Do not use vague confidence language.
- Do not celebrate routine completion or pad the response with generic offers to help.
- Reference local files with descriptive clickable labels when the host supports them. Put code in fenced blocks and keep examples minimal.
- End on the most useful handoff: what changed, how it was verified, and any real remaining limitation.

## Transcript hierarchy

Render content in this order:

1. User request in a soft, compact prompt surface.
2. Assistant reasoning-visible updates as muted activity/status rows, not large chat bubbles.
3. Tool calls, commands, searches, and file changes as compact disclosure rows.
4. Artifacts such as code, diffs, tables, images, or previews in purpose-built surfaces.
5. Final answer as clean unboxed prose with stronger placement, not louder color.

Do not expose hidden chain-of-thought. A progress row describes the action and evidence at a useful level: “Checking the saved window bounds,” not internal token-by-token reasoning.

## Activity row anatomy

```text
[state icon] Verb + object                         [duration] [disclosure]
             optional one-line result or problem
```

- Use present participles for running work: “Inspecting styles…”
- Use past tense for completed work: “Validated the skill.”
- Use explicit state for blocking work: “Waiting for folder access.”
- Keep routine rows to one line. Add a second line only for the salient result, error, or next action.
- Raw output belongs behind disclosure unless it is the evidence the user asked to see.

## Formatting details

- Body text: 14–16 px, 1.5 line height, primary text color.
- Paragraph spacing: 12–16 px. List item spacing: 4–8 px.
- Headings: sentence case, medium/semibold, restrained size steps.
- Links: semantic link color plus underline on hover/focus; never rely on color alone in dense prose.
- Inline code: neutral fill and monospace. Multi-line code: dedicated block with language and copy control.
- Tables: use only for repeated mappings or comparisons; keep borders quiet and headers sticky in long tables.
- Quotes: use a subtle leading rule; avoid oversized quotation styling.
- Warnings and notes: icon + short label + direct consequence. Do not turn ordinary context into an alert.

## Good density

The interface should reveal enough operational detail to earn trust without making logs the main product. Default to a concise summary, keep meaningful evidence one click away, and automatically surface failure details that explain a blocked result.
