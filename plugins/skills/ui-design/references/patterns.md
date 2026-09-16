# UI Patterns

## Application shell

Use three conceptual zones even when one is hidden:

```text
┌──────── navigation ────────┬──────────── focused work ────────────┬── context/tool ──┐
│ app / project switcher     │ title + task actions                  │ review / browser │
│ new task                   │                                       │ terminal / files  │
│ projects and task history  │ transcript, plan, artifacts           │ inspector         │
│ account / settings         │                                       │                   │
│                            │ composer / next action                 │                   │
└────────────────────────────┴───────────────────────────────────────┴───────────────────┘
```

- Navigation uses a slightly differentiated neutral surface and a preferred width of 275 px.
- Focused work owns the visual center and is never boxed as a whole.
- Context/tool panes are optional, resizable where useful, dismissible, and separated with a hairline.
- Pane titles are short. Put overflow actions at the trailing edge and keep primary task actions near the task title.
- Persist deliberate pane widths and open state, but recover safely when the display changes.

## Sidebar and navigation

- Use compact rows with a 28–36 px visual height, 8–12 px horizontal padding, and an 8 px radius.
- Keep icons 16 px and labels one line. Truncate the middle of paths and the end of ordinary titles; reveal the full value on hover/focus.
- Selected rows use a subtle neutral fill and medium-weight label, not a bright brand block.
- Group by user mental model: create/open, projects, recent tasks, saved/custom sections, account/settings.
- Avoid divider noise. Prefer 12–20 px group spacing and a small muted section label.
- Put destructive or rarely used actions in contextual menus, not permanently beside every row.

## Task header and transcript

- Use a quiet 52 px header for title, state, and task-level actions. Long titles truncate; full text remains accessible.
- Keep ordinary transcript content at or below 48 rem. Allow code, tables, diffs, and visual artifacts to break out to 56 rem or the pane width.
- A user prompt may use a soft neutral bubble aligned with the content edge. Assistant output stays unboxed and left-aligned.
- Separate turns with generous vertical rhythm rather than horizontal rules.
- Show live work as compact, timestamp-free status/activity rows unless time is meaningful.
- Collapse completed low-level tool details. Preserve the summary, success/failure state, and an affordance to inspect raw output.
- Keep the current activity near the bottom of the transcript without causing layout jumps or stealing focus.

## Composer

- Anchor the composer to the bottom of the focused work pane and align it with the transcript measure.
- Use a 44 px minimum outer height, 22 px single-line radius, 16 px multiline radius, and a subtle stroke/elevation.
- Internal icon actions are 28–36 px, with at least a 36 px pointer target and a 44 px touch target when touch is plausible.
- Let input grow to a bounded height, then scroll internally. Never push the send/run action offscreen.
- Place attachment/context controls at the leading edge and send/stop/voice at the trailing edge. Keep environment/model controls in a quiet secondary row or adjacent menu.
- The running state replaces send with a clear stop control without moving the whole composer.
- Attached files display as removable chips with type, truncated name, and validation/error state.

## Buttons, fields, menus, and cards

- Default buttons are neutral. Use a dark/light high-contrast solid button for the single primary action in a region.
- Use red only for a confirmed destructive action, never as a generic emphasis color.
- Compact control heights: 28 px small, 32 px default, 36 px comfortable. Form-heavy settings may use 36–40 px.
- Menus use 32–36 px rows, 8–12 px padding, 8–12 px container radius, a hairline, and restrained popover shadow.
- Inputs use a visible focus ring and a subtle border at rest. Placeholder text is tertiary, not disabled-looking.
- Cards are for discrete artifacts or decisions, not for every paragraph. Use an unfilled section before adding another card.
- Empty states include one sentence of orientation and one obvious next action; illustrations are optional and subdued.

## Code, command, diff, and terminal surfaces

### Inline and block code

- Use the native monospace stack at 12–13 px for chrome and 13–14 px for readable code.
- Inline code gets a subtle neutral fill, 4 px radius, and 0.1–0.15 em horizontal padding.
- Code blocks use a distinct surface, 8–12 px radius, a compact language/path header, copy action, and horizontal scrolling. Do not soft-wrap source code by default.
- Line numbers and metadata are tertiary. Selected lines and search matches must remain legible in both themes.

### Commands and tool activity

- Present a command as one compact row: status icon, monospace command, optional duration, and disclosure control.
- Keep stdout/stderr collapsed when successful and unremarkable. Expand failures or directly relevant evidence.
- Distinguish running, succeeded, failed, cancelled, and waiting-for-user states with icon + text, not color alone.
- Never simulate progress that the system cannot measure. Indeterminate work uses a restrained spinner or pulsing dot.

### Diffs and review

- Use green and red as semantic accents on added/removed lines, with low-opacity backgrounds and readable foregrounds.
- Provide file path, counts, hunk controls, and open/review actions in the pane header.
- Keep unchanged context neutral. Avoid saturated full-width blocks.
- Support side-by-side only when width permits; fall back to unified diff before text becomes cramped.

### Terminal

- Terminal content uses a near-black or theme surface without ornamental chrome.
- Preserve ANSI meaning while mapping colors for contrast. Keep selection, cursor, and focus visibly distinct.
- Put terminal tabs and controls in a 40 px pane toolbar. Let users resize or close the pane without losing the task transcript.

## Feedback states

- Loading: preserve layout dimensions; use skeletons only where content shape is predictable.
- Success: short confirmation near the affected control; avoid celebratory effects for routine actions.
- Warning: state the consequence and the safe path forward.
- Error: explain what failed, what remains intact, and the next recovery action. Keep raw diagnostics expandable.
- Permission or confirmation: isolate the consequential action, name its scope, and provide a clear cancel path.
- Offline/disconnected: keep readable local context available and mark actions that cannot proceed.

## Accessibility and localization

- Meet WCAG AA contrast for text and controls; do not reduce opacity until text becomes ambiguous.
- Keep a visible 2 px focus treatment around the actual interactive target.
- Maintain logical tab order across panes. Opening a panel moves focus only when the user's action implies it; closing returns focus to its trigger.
- Announce streaming status and completed work without repeatedly interrupting screen readers.
- Respect 200% zoom, increased contrast, reduced transparency, and reduced motion.
- Avoid fixed-width labels. Verify long German labels, CJK text, RTL layout, long repository paths, and mixed code/prose.
