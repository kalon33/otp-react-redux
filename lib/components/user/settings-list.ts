/**
 * Grouped inset lists for the AppFrame pages the app menu opens (Settings,
 * Saved places, Share feedback) — the Apple Preferences pattern: an eyebrow
 * over each section, the section's rows in one flat card on the --tn-bg
 * ground, hairlines between rows, and the explanatory sentence as a footnote
 * UNDER the card rather than wedged between controls.
 *
 * Built on the shared primitives (lib/components/util/tn-styled.ts) and the
 * tokens only, so light and dark both come for free. These pages are routed
 * outside `.otp.mobile`; on desktop the same markup renders as plain stacked
 * cards, which is harmless there.
 */
import styled, { css } from 'styled-components'

import { TnCard, TnEyebrow } from '../util/tn-styled'

/** The page body: room under the bar, and past the home indicator. */
export const SettingsPage = styled.div`
  padding: var(--tn-space-2) 0 calc(var(--tn-space-6) + var(--tn-safe-bottom));
`

/** One titled group: eyebrow, card, footnote. */
export const SettingsSection = styled.section`
  margin-top: var(--tn-space-5);

  &:first-child {
    margin-top: var(--tn-space-2);
  }
`

/** The section's eyebrow, inset to line up with the row text. */
export const SettingsSectionTitle = styled(TnEyebrow).attrs({ as: 'h2' })`
  padding: 0 var(--tn-space-4) var(--tn-space-2);
`

/** The flat card holding a section's rows. */
export const SettingsCard = styled(TnCard).attrs({
  $flat: true,
  $padding: 'none'
})`
  /* No overflow: hidden — it would clip the slider thumbs' focus rings. */
  position: relative;
`

/**
 * A card that is a list (`<ul>` of `<li>` rows, e.g. TnListRow links): the
 * same card, with the hairline between items instead of between rows.
 */
export const SettingsList = styled(SettingsCard).attrs({ as: 'ul' })`
  list-style: none;
  margin: 0;

  > li + li {
    box-shadow: inset 0 1px 0 var(--tn-border);
  }
  /* The rows' pressed state must follow the card's corners. */
  > li:first-child > * {
    border-top-left-radius: var(--tn-radius);
    border-top-right-radius: var(--tn-radius);
  }
  > li:last-child > * {
    border-bottom-left-radius: var(--tn-radius);
    border-bottom-right-radius: var(--tn-radius);
  }
`

/** The sentence that explains a section, under its card. */
export const SettingsFootnote = styled.p`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  margin: 0;
  padding: var(--tn-space-2) var(--tn-space-4) 0;
`

/** A sentence that leads a page (under the bar, above the first card). */
export const SettingsLead = styled.p`
  color: var(--tn-text-2);
  font: var(--tn-type-body);
  margin: 0 0 var(--tn-space-4);
  padding: 0 var(--tn-space-4);
`

const hairline = css`
  & + & {
    box-shadow: inset 0 1px 0 var(--tn-border);
  }
`

/**
 * A row that holds a slider: its label, the lever, and the lever's own help
 * line, inside the card. Taller than a 52px row because it is three lines.
 */
export const LeverBlock = styled.div`
  padding: var(--tn-space-3) var(--tn-space-4);
  ${hairline}

  > label {
    color: var(--tn-text);
    display: block;
    font: var(--tn-type-body);
    font-variant-numeric: var(--tn-tabular);
    margin: 0;
    padding: 0;
  }

  /* trip-form's SliderSelector: Less [——o——] More. The range input is given
     a 44px box so the thumb is a real tap target; the track still draws at
     its own height in the middle of it. */
  [role='group'] {
    margin: var(--tn-space-1) 0;
  }
  [role='group'] > div {
    gap: var(--tn-space-3);
  }
  [role='group'] span {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
    padding: 0;
  }
  input[type='range'] {
    accent-color: var(--tn-accent);
    height: var(--tn-tap);
    margin: 0;
  }
`

/** The lever's help line, inside its block. */
export const LeverHelp = styled.p`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  margin: 0;
`

/**
 * An iOS-style switch drawn on a real checkbox: 51x31 track, 27px knob,
 * accent when on. The input keeps its id, its `checked` and its change event
 * — this is only paint.
 */
export const switchCss = css`
  appearance: none;
  background-color: var(--tn-border);
  border: 0;
  border-radius: var(--tn-radius-pill);
  cursor: pointer;
  flex: none;
  height: 31px;
  margin: 0;
  position: relative;
  transition: background-color 160ms ease;
  width: 51px;

  &::before {
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    content: '';
    height: 27px;
    left: 2px;
    position: absolute;
    top: 2px;
    transition: transform 160ms ease;
    width: 27px;
  }
  &:checked {
    background-color: var(--tn-accent);
  }
  &:checked::before {
    transform: translateX(20px);
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    &,
    &::before {
      transition: none;
    }
  }
`

/**
 * A 52px row with a label on the left and a switch on the right, wrapping
 * trip-form's CheckboxSelector (`<div><input type=checkbox/><label/></div>`)
 * so the input keeps its `id-query-param-<name>` id and change event. The
 * label spans the row, so a tap anywhere on it flips the switch.
 */
export const ToggleRow = styled.div`
  ${hairline}

  > div {
    align-items: center;
    display: flex;
    gap: var(--tn-space-3);
    margin: 0;
    min-height: var(--tn-row-h);
    padding: var(--tn-space-2) var(--tn-space-4);
  }
  label {
    color: var(--tn-text);
    cursor: pointer;
    flex: 1;
    font: var(--tn-type-body);
    margin: 0;
    padding: 0;
  }
  input[type='checkbox'] {
    ${switchCss}
    order: 2;
  }
`
