/**
 * TransitNav shared styled primitives (mobile overhaul, 2026-10-26).
 *
 * Each export is ONLY css over a plain element: no behaviour, no props beyond
 * the `$`-prefixed style switches (transient props, never reach the DOM). Use
 * them instead of re-inventing cards, pills and rows per screen; restyle with
 * `styled(TnCard)` or the `as` prop when a screen needs a variant.
 *
 * Every value comes from lib/styles/tokens.css, so light/dark switch with no
 * work here. The same recipes exist as classes in lib/styles/base.css
 * (.tn-btn, .tn-card, .tn-eyebrow, .tn-tabular) for plain .js components —
 * keep the two in step.
 */
import styled, { css } from 'styled-components'

/** Tabular figures: add to every time and duration. */
export const tnTabular = css`
  font-variant-numeric: var(--tn-tabular);
`

/* ------------------------------------------------------------------ */

export type TnButtonVariant = 'primary' | 'secondary' | 'ghost'

interface TnButtonProps {
  /** Full width (flex). */
  $block?: boolean
  /** 'md' = 48px (default, primary actions); 'sm' = 44px (inline pairs). */
  $size?: 'md' | 'sm'
  /** primary = accent pill; secondary = surface-2 pill; ghost = accent text. */
  $variant?: TnButtonVariant
}

const variantCss = {
  ghost: css`
    background-color: transparent;
    color: var(--tn-accent);
    padding: 0 var(--tn-space-3);

    &:active:not(:disabled) {
      background-color: var(--tn-accent-soft);
      filter: none;
    }
  `,
  primary: css`
    background-color: var(--tn-accent);
    color: var(--tn-accent-ink);
  `,
  secondary: css`
    background-color: var(--tn-surface-2);
    color: var(--tn-text);
  `
}

/** Button css, for `styled.a` / `styled(Link)` that must look like a button. */
export const tnButtonCss = css<TnButtonProps>`
  align-items: center;
  appearance: none;
  border: 0;
  border-radius: var(--tn-radius-pill);
  cursor: pointer;
  display: ${(p) => (p.$block ? 'flex' : 'inline-flex')};
  font: 600 16px/20px var(--tn-font);
  gap: var(--tn-space-2);
  justify-content: center;
  margin: 0;
  min-height: ${(p) =>
    p.$size === 'sm' ? 'var(--tn-tap)' : 'var(--tn-control-h)'};
  padding: 0 var(--tn-space-5);
  text-decoration: none;
  transition: filter 120ms ease, background-color 120ms ease;
  user-select: none;
  width: ${(p) => (p.$block ? '100%' : 'auto')};

  ${(p) => variantCss[p.$variant || 'primary']}

  &:active:not(:disabled) {
    filter: brightness(0.92);
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
  &:disabled,
  &[aria-disabled='true'] {
    cursor: default;
    filter: none;
    opacity: 0.45;
  }
  &:hover,
  &:focus {
    text-decoration: none;
  }
  svg {
    flex: none;
    height: 20px;
    width: 20px;
  }
`

/**
 * Pill button. `<TnButton type="button">Plan trip</TnButton>` (primary, 48px),
 * `$variant="secondary"` (surface-2 + text colour), `$variant="ghost"`
 * (accent text only), `$block` for full width, `$size="sm"` for 44px pairs.
 * Icons inside render 20px.
 */
export const TnButton = styled.button<TnButtonProps>`
  ${tnButtonCss}
`

/* ------------------------------------------------------------------ */

interface TnCardProps {
  /** No shadow: a grouped inset card on the --tn-bg ground (settings lists). */
  $flat?: boolean
  /** Inner padding: default 16px; 'none' for cards made of TnListRows. */
  $padding?: 'none' | 'sm' | 'md'
  /** A 4px stripe down the LEFT edge in this colour (e.g. the GTFS route). */
  $stripe?: string
}

const cardPadding = {
  md: 'var(--tn-space-4)',
  none: '0',
  sm: 'var(--tn-space-3)'
}

/**
 * Surface card: radius 16, shadow, 16px padding. `$flat` drops the shadow for
 * Apple-style grouped lists; `$stripe="#0053A0"` adds a 4px left route stripe;
 * `$padding="none"` when the card is a stack of TnListRows.
 */
export const TnCard = styled.div<TnCardProps>`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  /* The stripe is an inset shadow so it follows the rounded corners without
     overflow: hidden (which would clip dropdowns and focus rings). */
  box-shadow: ${(p) =>
    [
      p.$stripe ? `inset 4px 0 0 ${p.$stripe}` : null,
      p.$flat ? null : 'var(--tn-shadow)'
    ]
      .filter(Boolean)
      .join(', ') || 'none'};
  color: var(--tn-text);
  padding: ${(p) => cardPadding[p.$padding || 'md']};
  ${(p) =>
    p.$stripe &&
    css`
      padding-left: calc(${cardPadding[p.$padding || 'md']} + 4px);
    `}
`

/* ------------------------------------------------------------------ */

export type TnTone = 'neutral' | 'accent' | 'live' | 'warn' | 'danger'

interface TnChipProps {
  /** Toggle chips: selected = accent-soft + accent text + 600. */
  $selected?: boolean
  /** Status chips ("On Bus #2018", "No live bus data"): tinted, not toggles. */
  $tone?: TnTone
}

const toneCss: Record<TnTone, string> = {
  accent: 'background-color: var(--tn-accent-soft); color: var(--tn-accent);',
  danger: 'background-color: var(--tn-danger-soft); color: var(--tn-danger);',
  live: 'background-color: var(--tn-live-soft); color: var(--tn-live);',
  neutral: 'background-color: var(--tn-surface-2); color: var(--tn-text);',
  warn: 'background-color: var(--tn-warn-soft); color: var(--tn-warn);'
}

/**
 * Chip: 36px pill, 14px 500. As a toggle: `<TnChip $selected={on}
 * aria-pressed={on} type="button">Round trip</TnChip>`. As a status label:
 * `<TnChip as="span" $tone="live">On Bus #2018</TnChip>`. The visible pill is
 * 36px; a transparent ::after extends the touch area to 44px tall, so a tap-
 * target audit measuring getBoundingClientRect will report 36 — that is the
 * intended exception.
 */
export const TnChip = styled.button<TnChipProps>`
  align-items: center;
  appearance: none;
  border: 0;
  border-radius: var(--tn-radius-pill);
  cursor: pointer;
  display: inline-flex;
  flex: none;
  font: 500 14px/18px var(--tn-font);
  gap: 6px;
  margin: 0;
  min-height: 36px;
  padding: 0 14px;
  position: relative;
  white-space: nowrap;

  ${(p) => toneCss[p.$tone || 'neutral']}
  ${(p) =>
    p.$selected &&
    css`
      background-color: var(--tn-accent-soft);
      color: var(--tn-accent);
      font-weight: 600;
    `}

  &::after {
    bottom: -4px;
    content: '';
    left: 0;
    position: absolute;
    right: 0;
    top: -4px;
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
  &:disabled {
    cursor: default;
    opacity: 0.45;
  }
  svg {
    flex: none;
    height: 16px;
    width: 16px;
  }
`

/* ------------------------------------------------------------------ */

/**
 * List row: 52px min, 16px side padding, 12px gap, hairline between rows.
 * Put rows directly inside a `<TnCard $padding="none" $flat>` for a grouped
 * list. Render `as="button"` / `as="a"` / `as={Link}` when it is tappable
 * (it resets button chrome; `type="button"` / `href` rows get a pressed
 * state and pointer). Slots:
 *   <TnListRow as="button" type="button">
 *     <TnListRowIcon><Home /></TnListRowIcon>
 *     <TnListRowBody>
 *       <TnListRowTitle>Home</TnListRowTitle>
 *       <TnListRowSubtitle>123 Main St</TnListRowSubtitle>
 *     </TnListRowBody>
 *     <TnListRowTrail><ChevronRight /></TnListRowTrail>
 *   </TnListRow>
 */
export const TnListRow = styled.div`
  align-items: center;
  appearance: none;
  background-color: var(--tn-surface);
  border: 0;
  color: var(--tn-text);
  display: flex;
  font: var(--tn-type-body);
  gap: var(--tn-space-3);
  margin: 0;
  min-height: var(--tn-row-h);
  padding: var(--tn-space-2) var(--tn-space-4);
  text-align: start;
  text-decoration: none;
  width: 100%;

  & + & {
    box-shadow: inset 0 1px 0 var(--tn-border);
  }

  /* Tappable rows: as="button" type="button", as="a" href, as={Link}. */
  &[type='button'],
  &[href] {
    cursor: pointer;
  }
  &[type='button']:active,
  &[href]:active {
    background-color: var(--tn-surface-2);
  }
  &[href]:hover,
  &[href]:focus {
    color: var(--tn-text);
    text-decoration: none;
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: -2px;
  }
`

/** 22px icon slot in text-2 (pass `style={{ color }}` for a route colour). */
export const TnListRowIcon = styled.span`
  align-items: center;
  color: var(--tn-text-2);
  display: inline-flex;
  flex: none;
  height: 22px;
  justify-content: center;
  width: 22px;

  svg,
  img {
    height: 22px;
    width: 22px;
  }
`

/** The growing middle column; clips long text with an ellipsis. */
export const TnListRowBody = styled.span`
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`

/** Primary line: 16px 600. */
export const TnListRowTitle = styled.span`
  color: var(--tn-text);
  font: 600 16px/22px var(--tn-font);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** Secondary line: 14px text-2. */
export const TnListRowSubtitle = styled.span`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** Trailing slot: value text, toggle or a 16px chevron, in text-3. */
export const TnListRowTrail = styled.span`
  align-items: center;
  color: var(--tn-text-3);
  display: inline-flex;
  flex: none;
  font: var(--tn-type-sm);
  gap: var(--tn-space-1);

  svg {
    height: 16px;
    width: 16px;
  }
`

/* ------------------------------------------------------------------ */

/**
 * Eyebrow / section label: 12px 500 uppercase, 0.04em tracking, text-2.
 * Defaults to a <p>; use `as="h2"` (etc.) when it heads a section.
 */
export const TnEyebrow = styled.p`
  color: var(--tn-text-2);
  font: var(--tn-type-xs);
  letter-spacing: var(--tn-tracking-xs);
  margin: 0;
  text-transform: uppercase;
`

/* ------------------------------------------------------------------ */

/**
 * Bottom-sheet grabber tab: a surface tab with rounded top corners, an upward
 * shadow and a 36x5 handle bar (::before), with an optional label child
 * (14px 600 text-2) under the bar. 44px tall minimum. Positioning is the
 * caller's — wrap it: `styled(TnSheetGrabber)` with `position: absolute;
 * bottom: 0; left: 50%; transform: translateX(-50%)` for the Go Mode tab, or
 * place it at the top of a sheet with `$bare` (no tab chrome, just the bar).
 */
export const TnSheetGrabber = styled.button<{ $bare?: boolean }>`
  align-items: center;
  appearance: none;
  background-color: ${(p) => (p.$bare ? 'transparent' : 'var(--tn-surface)')};
  border: 0;
  border-radius: var(--tn-radius) var(--tn-radius) 0 0;
  box-shadow: ${(p) => (p.$bare ? 'none' : 'var(--tn-shadow-up)')};
  color: var(--tn-text-2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  font: 600 14px/18px var(--tn-font);
  gap: 6px;
  justify-content: flex-start;
  margin: 0;
  min-height: var(--tn-tap);
  min-width: 96px;
  padding: var(--tn-space-2) var(--tn-space-6) var(--tn-space-3);

  &::before {
    background-color: var(--tn-text-3);
    border-radius: var(--tn-radius-pill);
    content: '';
    flex: none;
    height: 5px;
    opacity: 0.6;
    width: 36px;
  }
  &:active {
    background-color: ${(p) =>
      p.$bare ? 'transparent' : 'var(--tn-surface-2)'};
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: -2px;
  }
`
