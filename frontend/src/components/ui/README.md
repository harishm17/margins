# UI primitives

One component per file. Tokens, type scale, radii and motion live in `src/app/globals.css`;
components use the semantic names only (`bg-surface`, `text-fg-2`, `rounded-card`, `text-small`).
Icons are Phosphor, imported from `@phosphor-icons/react/dist/ssr` and passed to components as
elements (`icon={<Plus />}`), which keeps every primitive usable from server components.

| File | Exports | Notes |
|---|---|---|
| `relative-time.tsx` | `RelativeTime`, `DueLabel` | "2h ago" and "Due today" labels |
| `button.tsx` | `Button`, `buttonVariants` | primary, secondary, ghost, danger, link; sm, md, lg; `icon`, `kbd`, `loading`, `asChild` |
| `icon-button.tsx` | `IconButton` | square, `label` is the aria-label and the tooltip |
| `input.tsx` | `Input` | leading `icon`, `trailing` slot, `invalid` |
| `textarea.tsx` | `Textarea` | auto-grows, min 3 rows |
| `field.tsx` | `Field` | label, hint, error, optional; wires ids to the control |
| `select.tsx` | `Select` | Radix select with an `options` array |
| `checkbox.tsx` | `Checkbox` | optional `label`, `description`, `trailing` |
| `segmented-control.tsx` | `SegmentedControl` | radio group semantics, arrow keys |
| `tabs.tsx` | `Tabs` | underline tabs as links, scrolls with fade edges |
| `badge.tsx` | `Badge` | neutral, accent, warning, danger |
| `card.tsx` | `Card` | `compact`, `interactive`, `asChild` |
| `dialog.tsx` | `Dialog` and parts | 440 / 560 / 720 |
| `confirm-dialog.tsx` | `ConfirmDialog` | names the action, async confirm |
| `sheet.tsx` | `Sheet` and parts | right sheet (bottom sheet on mobile) or left sheet |
| `popover.tsx` | `Popover` and parts | |
| `dropdown-menu.tsx` | `DropdownMenu` and parts | items, radio items, submenus, kbd hints |
| `tooltip.tsx` | `Tooltip`, `TooltipProvider` | for icon buttons and truncated text |
| `hover-card.tsx` | `HoverCard` and parts | 340px, 300ms delay |
| `toaster.tsx` | `Toaster`, `toast` | sonner |
| `progress.tsx` | `Progress` | 4px bar, `indeterminate` |
| `progress-ring.tsx` | `ProgressRing` | 16 / 28 / 44 / 96, empty state |
| `mastery-indicator.tsx` | `MasteryIndicator` | ring plus label, or ring with tooltip |
| `skeleton.tsx` | `Skeleton`, `SkeletonText` | shimmer, off under reduced motion |
| `page-skeleton.tsx` | `SkeletonPage`, `SkeletonIntro`, `SkeletonRow(s)`, `SkeletonField`, `SkeletonSection` | the one way to build a `loading.tsx`: parts at the sizes of the page they stand in for (intro = `PageIntro`, row = list row, field = input), so the page replaces them without moving |
| `empty-state.tsx` | `EmptyState` | `as="h1"` for a page that is only this (a 404) |
| `inline-alert.tsx` | `InlineAlert` | neutral, accent, warning, danger |
| `job-status.tsx` | `JobStatus`, `stageLabel` | the one way to show a background job |
| `question-renderer.tsx` | `QuestionRenderer` | multiple choice, true/false, numerical, short answer; a stem with a table or listing is drawn as blocks |
| `question-text.tsx` | `QuestionText`, `stemHasBlocks` | a question stem: one line is inline text with math, anything longer goes through the block renderer so tables stay tables |
| `scrollable.ts` | `useScrollableFocus` | makes content that scrolls sideways (equations, code, tables) reachable from the keyboard, only when it overflows |
| `theme-switch.tsx` | `ThemeSwitch`, `ThemeMenuRadios`, `useThemeChoice` | Light, Dark or System: an icon button with a menu for public pages (the public header, sign in), and the same three choices as menu items inside the account menu |
| `markdown.tsx` | `Markdown`, `MarkdownInline` | heavy: import through `lazy-markdown.tsx` |
| `lazy-markdown.tsx` | `LazyMarkdown`, `LazyMarkdownInline` | next/dynamic wrappers |
| `math-text.tsx` | `MathText` | every model-written string in running text: inline markdown and KaTeX, plain strings render at once |
| `kbd.tsx` | `Kbd`, `KeyHint` | Keyboard hints; hidden on touch-first devices (`pointer: coarse`) unless `persistent` |
| `spinner.tsx` | `Spinner` | |
| `styles.ts` | shared class strings | floating surface, menu item |

Rules: radius is 6 (chips), 8 (buttons, inputs), 12 (cards, overlays), full. Cards have no
shadow; only floating things do. Focus uses the global 2px accent ring.

Accessibility rules the primitives keep: a link inside a sentence is underlined at rest (a global
rule on `p a`, and the `link` button variant); form controls use the `control` border token (3:1),
not `border-strong`; "Learning" mastery is never colour alone (dashed ring arcs, the `bg-learning`
striped fill); a target is 24px at least, and 44px on a phone for the Button, Input, Select and
SegmentedControl (the Checkbox and the link variant widen their hit area without moving anything).
