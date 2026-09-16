# UI Foundations

## Status of these specifications

This is a practical abstraction of a dense desktop workbench observed on 2026-09-16. Public documentation does not publish a UI kit or immutable visual specifications. Exact values below are therefore a reproducible version baseline. Re-check the current app when pixel fidelity matters.

## Window and layout baseline

| Property               |                                                     Baseline | Use                                                              |
| ---------------------- | -----------------------------------------------------------: | ---------------------------------------------------------------- |
| First primary window   |                                                  1280×820 px | Desktop default before saved bounds exist                        |
| Minimum primary window |                                                   480×600 px | Below this, use a dedicated compact layout rather than squeezing |
| Saved bounds           |                                    Restore last valid bounds | Preserve user agency across launches                             |
| Windows first launch   | Up to 85% work-area width and 80% height, capped at 1280×820 | Avoid opening beyond a small display                             |
| Sidebar                |                           preferred 275 px; clamp 240–520 px | Resizable navigation/project rail                                |
| Main toolbar           |                                                        52 px | Primary title/actions row                                        |
| Compact toolbar        |                                                        36 px | Dense nested surfaces                                            |
| Pane toolbar           |                                                        40 px | Review, terminal, browser, and inspector panes                   |
| Transcript measure     |                                              48 rem / 768 px | Prose, messages, plans, and ordinary code                        |
| Wide artifact measure  |                                              56 rem / 896 px | Tables, larger diffs, and diagrams; panels may use more          |
| Spacing base           |                                                         4 px | Use integer multiples except optical hairlines                   |

On macOS, retain native traffic lights and a draggable title region. On Windows and Linux, reserve space for system window controls even when using a custom title bar. Do not paint important actions into drag regions.

### Responsive pane behavior

- At 1100 px and wider, navigation + work + optional context panel may coexist.
- From 760–1099 px, keep the work area primary; make either navigation or context collapsible.
- From 480–759 px, show only one main pane and present navigation/context as drawers or explicit routes.
- Do not make dense desktop chrome into a scaled-down mobile UI. Change structure before reducing text or hit targets.

## Typography

Use system fonts so the interface feels native and remains legible across platforms.

```css
--font-ui:
    -apple-system-body, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica,
    Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
--font-code:
    ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
```

Do not require a private branded font. If a licensed display font is supplied by the product, it may be used for branded display text; keep utility UI on the system stack.

### Dense desktop type scale

| Role                      | Size / line height                              |  Weight |
| ------------------------- | ----------------------------------------------- | ------: |
| Micro metadata, badges    | 11 / 16 px                                      | 400–500 |
| Secondary controls        | 12 / 16 px                                      | 400–500 |
| Navigation, labels        | 13 / 18 px                                      | 400–500 |
| Primary UI and transcript | 14 / 21 px                                      |     400 |
| Composer / document prose | 16 / 24 px when extra reading comfort is needed |     400 |
| Small section heading     | 18 / 24 px                                      | 500–600 |
| Page or pane heading      | 20–24 / 28–32 px                                | 500–600 |
| App empty-state heading   | 28 / 34 px                                      | 500–600 |

Use weight 500 for most emphasis. Reserve 600 for strong headings and selected labels; avoid bold walls of text. Use tabular numerals for durations, counts, and line numbers. Use monospace only for code, commands, paths, hashes, and machine values.

## Color system

The visual character comes from low-chroma neutral layers. Implement semantics rather than binding components directly to palette numbers.

### Neutral ramp baseline

| Token     | Light     | Dark      |
| --------- | --------- | --------- |
| gray-0    | `#ffffff` | `#0d0d0d` |
| gray-25   | `#fcfcfc` | `#101010` |
| gray-50   | `#f9f9f9` | `#131313` |
| gray-75   | `#f3f3f3` | `#161616` |
| gray-100  | `#ededed` | `#181818` |
| gray-150  | `#dfdfdf` | `#1c1c1c` |
| gray-200  | `#cdcdcd` | `#212121` |
| gray-300  | `#afafaf` | `#303030` |
| gray-400  | `#8f8f8f` | `#414141` |
| gray-500  | `#5d5d5d` | `#5d5d5d` |
| gray-600  | `#414141` | `#8f8f8f` |
| gray-700  | `#303030` | `#afafaf` |
| gray-800  | `#212121` | `#cdcdcd` |
| gray-900  | `#181818` | `#ededed` |
| gray-950  | `#131313` | `#f3f3f3` |
| gray-1000 | `#0d0d0d` | `#ffffff` |

Recommended semantic mapping:

- Canvas: gray-0; sidebar/subtle surface: gray-50; selected/hover surface: gray-75 to gray-100.
- Dark canvas: gray-0's dark value; subtle surface: gray-50 to gray-100's dark value.
- Primary text: gray-1000; secondary text: gray-600; tertiary text: gray-400/500.
- Hairline: primary text at 5–8% opacity; strong divider: 12–16%.
- Focus/info/link: light `#0169cc`, dark `#339cff`.
- Success: light `#008635`, dark `#40c977`.
- Warning: light `#923b0f`, dark `#ff8549`.
- Danger/deletion: light `#ba2623`, dark `#fa423e`.

Large surfaces should not be tinted with semantic colors. Use color on a small icon, label, border, or diff line and pair it with text or shape.

## Shape, borders, and elevation

Use a radius ladder derived from 2, 4, 6, 8, 12, 16, 24, and 32 px. Typical mapping:

- Tiny badges and inline code: 4 px.
- Fields, menu rows, small cards: 6–8 px.
- Popovers and panels: 12–16 px.
- Composer: 16 px when multiline; 22 px or pill when single-line.
- Round icon controls and mode rows: full pill.

Prefer a 0.5–1 px neutral hairline over a shadow. When separation needs depth, use restrained geometry:

```css
--shadow-sm: 0 1px 2px -1px rgb(0 0 0 / 8%);
--shadow-md: 0 2px 4px -1px rgb(0 0 0 / 8%);
--shadow-lg: 0 4px 8px -2px rgb(0 0 0 / 10%);
--shadow-popover: 0 3px 8px rgb(0 0 0 / 6%), 0 0 20px rgb(0 0 0 / 5%);
```

Avoid floating every container. A pane is usually separated by a hairline; a popover, menu, or composer can receive elevation.

## Motion

- Basic hover, focus, and press: 150 ms.
- Pane, popover, and layout changes: 300 ms maximum.
- Enter curve: `cubic-bezier(.19, 1, .22, 1)`.
- Move curve: `cubic-bezier(.65, 0, .35, 1)`.
- Exit curve: `cubic-bezier(.8, 0, .4, 1)`.
- Animate opacity and transform first. Avoid decorative parallax, elastic overshoot, or continuous motion.
- Under `prefers-reduced-motion: reduce`, remove nonessential transitions and preserve state changes instantly.

## Iconography

Use simple 16–18 px outline icons with 1.5–2 px strokes, round joins, and consistent optical size. Icons are usually neutral; selected or semantic states may carry color. Every unfamiliar icon needs a tooltip and accessible name. Do not substitute emoji for product icons.
