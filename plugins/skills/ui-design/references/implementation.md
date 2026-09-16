# Implementing and Reviewing Workbench UI

## Start from semantic tokens

Copy or adapt `../assets/ui-tokens.css`. Components should consume semantic names such as `--ew-ui-bg-canvas`, `--ew-ui-text-secondary`, and `--ew-ui-border` rather than palette values. Keep platform and theme differences at the token layer.

Do not copy an installed app's bundled stylesheet. The asset in this skill is a maintained abstraction with a small, stable surface.

## Build order

1. Implement canvas, typography, focus, and theme switching.
2. Establish the pane grid and responsive collapse behavior.
3. Add transcript measure and bottom composer.
4. Add compact navigation, buttons, menus, fields, and disclosures.
5. Add specialized code, diff, terminal, and status surfaces only when the product needs them.
6. Populate realistic long and error states before polishing shadows or animation.

For an existing product, map these tokens and relationships onto its component system. Do not replace accessible, tested controls solely to improve resemblance.

## CSS behavior expectations

- Apply `color-scheme: light dark` and support an explicit `[data-theme]` override.
- Use `minmax(0, 1fr)` for the work pane so long content cannot force the grid wider.
- Use `clamp(240px, var(--ew-ui-sidebar-width, 275px), min(520px, calc(100vw - 320px)))` for a resizable desktop sidebar.
- Use container or media queries to collapse panels; never solve width pressure by globally shrinking type.
- Make title bar drag regions opt-in and mark controls `-webkit-app-region: no-drag` in Electron.
- Use logical properties (`padding-inline`, `border-inline-start`) for RTL readiness.
- Let text wrap, but truncate paths and one-line titles deliberately with a title/tooltip or accessible full-value affordance.
- Keep sticky composer and toolbars within their own scrolling pane so the page does not develop competing scroll roots.
- Disable or shorten motion under `prefers-reduced-motion`.

## State model

Every asynchronous component should be designed for:

- idle
- queued
- running or streaming
- waiting for user input/permission
- succeeded
- failed with retry/recovery
- cancelled
- disconnected or stale

Do not encode the entire state in spinner visibility. Labels, controls, and accessible status announcements must agree with the underlying state.

## Fidelity review rubric

Score each item 0–2. A result below 18/24 needs another pass.

| Area                | 0                       | 1              | 2                                         |
| ------------------- | ----------------------- | -------------- | ----------------------------------------- |
| Task clarity        | unclear                 | understandable | immediate and focused                     |
| Pane hierarchy      | cramped/flat            | mostly clear   | focused work dominates                    |
| Density             | wasteful/noisy          | mixed          | compact and calm                          |
| Typography          | decorative/inconsistent | acceptable     | native, restrained, readable              |
| Neutral surfaces    | muddy/high-chroma       | mostly neutral | subtle layered contrast                   |
| Borders/elevation   | heavy/everywhere        | mixed          | hairlines first, depth selective          |
| Composer            | detached/fragile        | usable         | anchored, clear states, resilient         |
| Transcript          | bubble-heavy/log-heavy  | mixed          | unboxed answer, progressive detail        |
| Developer artifacts | generic textarea        | partial        | purpose-built code/diff/terminal          |
| Responsive behavior | squeezed                | some collapse  | structural pane adaptation                |
| Accessibility       | missing                 | partial        | keyboard, contrast, motion, zoom verified |
| Output voice        | verbose/vague           | adequate       | outcome-first and evidence-aware          |

## Verification matrix

At minimum, inspect:

- 1280×820: default three-zone proportions.
- 960×720: one secondary zone collapsed.
- 480×600: single-pane navigation and reachable composer.
- Light and dark themes.
- 200% zoom and long localized strings.
- Keyboard traversal and visible focus.
- Reduced motion and increased contrast when supported.
- A long task title, deeply nested path, multi-line command, large diff, failed command, permission request, and disconnected state.

Capture screenshots for visual review when the environment allows it. Fix clipping, competing scrollbars, low contrast, and unstable layout before fine-tuning color or shadow.
