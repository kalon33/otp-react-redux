import { grey } from '../util/colors'
import styled, { css } from 'styled-components'

export const buttonPixels = 51

export const activeCss = css`
  /* Make elements internal content slightly transparent on hover. */
  & > * {
    opacity: 90%;
  }
`

const buttonTransitionCss = css`
  transition: all 250ms ease-out;
`

export const boxShadowCss = css`
  box-shadow: rgba(0, 0, 0, 0.15) 0 0 20px;
`

// TODO: this needs to be in line with the mode selector buttons, ideally importing the styles
export const buttonCss = css`
  border-radius: 5px;
  border: 0px;
  height: ${buttonPixels}px;
  margin: 0px;
  width: ${buttonPixels}px;
  ${buttonTransitionCss}

  &:active {
    background: ${grey[50]};
  }

  &:hover {
    ${boxShadowCss}
  }

  svg {
    max-height: 36px;
  }
`

export const Button = styled.button`
  ${buttonCss}
`

export const TripFormButtonContainer = styled.div`
  display: flex;
  gap: 2px;
`

export const AdvancedOptionsContainer = styled.div`
  align-items: center;
  color: ${grey[800]};
  display: flex;
  justify-content: space-between;
`

export const PlanTripButton = styled(Button)`
  background-color: green;
  color: #ffffffdd;
  padding: 5px;

  &:active {
    ${activeCss}
    background: green;
    filter: saturate(50%);
  }

  span {
    display: inline-block;
    margin-top: -5px;
  }
`

export const ModeSelectorContainer = styled.div`
  align-items: flex-start;
  display: flex;
  float: right;
  justify-content: space-between;
  width: 100%;

  fieldset {
    gap: 0 2px;
    margin: 0 2px 0 0;

    input {
      margin: 0;
    }
  }
`

export const MainSettingsRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
`

/*
 * ---- Phone search form (mobile overhaul, 2026-10-26) ----
 * Rendered only by BatchSettings' `mobile` layout (batch-search-screen), so
 * none of this reaches the desktop routing panel. The form sits on the
 * --tn-bg ground; everything the rider taps is a --tn-surface face on it.
 */

/** The whole phone form column under the route card. */
export const MobileSettingsColumn = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--tn-space-3);
  margin-top: var(--tn-space-3);
`

/**
 * Leave now ▾ · Round trip · Options, then — only with the round trip on —
 * its "1 h+ there" line and stay chips as a second row. RoundTripSettings and
 * its toggle row are `display: contents` here so the toggle is a chip in this
 * row while the stays wrap onto their own full-width line below it.
 */
export const MobileChipRow = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: var(--tn-space-2);

  .round-trip-settings,
  .round-trip-toggle-row {
    display: contents;
  }
  .round-trip-stay-readout {
    color: var(--tn-text-2) !important;
    flex-basis: 100%;
    font: var(--tn-type-sm) !important;
    order: 4;
    padding: 0 var(--tn-space-1);
  }
  .round-trip-stays {
    flex-basis: 100%;
    order: 5;
  }

  /* 360 px: the three chips only fit on one line with tighter sides. */
  @media (max-width: 374px) {
    gap: 6px;

    > button,
    .round-trip-toggle-row > button,
    #date-time-depart-arrive-label {
      padding-left: 10px !important;
      padding-right: 10px !important;
    }
  }

  /* building-blocks Dropdown ("Leave now ▾"): its toggle carries an inline
     transparent background, hence the !important. */
  #date-time-depart-arrive-wrapper {
    display: inline-flex;
  }
  #date-time-depart-arrive-label {
    align-items: center;
    background-color: var(--tn-surface) !important;
    border-radius: var(--tn-radius-pill);
    box-shadow: var(--tn-shadow);
    color: var(--tn-text) !important;
    display: inline-flex;
    font: 500 14px/18px var(--tn-font);
    gap: 6px;
    min-height: 36px;
    padding: 0 12px 0 14px;
    position: relative;
    white-space: nowrap;
  }
  #date-time-depart-arrive-label::after {
    bottom: -4px;
    content: '';
    left: 0;
    position: absolute;
    right: 0;
    top: -4px;
  }
  #date-time-depart-arrive-label .caret {
    border-top-color: var(--tn-text-2);
    margin: 0;
  }
  #date-time-depart-arrive-label + div {
    min-width: 180px;
    padding: var(--tn-space-1) 0;
    z-index: 20;
  }
  #date-time-depart-arrive-label + div button {
    color: var(--tn-text);
    font: var(--tn-type-body);
    min-height: var(--tn-tap);
    padding: 0 var(--tn-space-4);
    text-align: start;
    width: 100%;
  }
  #date-time-depart-arrive-label + div button[aria-pressed='true'] {
    color: var(--tn-accent);
    font-weight: 600;
  }
`

/** A chip on the form ground: surface at rest, accent-soft when on. */
export const formChipCss = css`
  box-shadow: var(--tn-shadow);
  &:not([aria-pressed='true']) {
    background-color: var(--tn-surface);
    color: var(--tn-text);
  }
  &[aria-pressed='true'] {
    background-color: var(--tn-accent-soft);
    box-shadow: none;
    color: var(--tn-accent);
    font-weight: 600;
  }
  svg {
    color: var(--tn-text-2);
  }
  &[aria-pressed='true'] svg {
    color: var(--tn-accent);
  }
`

/** Depart/arrive time and date, open under the chips when not "Leave now". */
export const MobileDateTimeCard = styled.div`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: var(--tn-shadow);
  padding: var(--tn-space-2);

  .date-time-selector {
    background: transparent;
    display: flex;
    gap: var(--tn-space-2);
    height: auto;
    margin: 0;
  }
  .date-time-selector > div {
    flex: 1;
    max-width: none;
    min-width: 0;
  }
  .date-time-selector input {
    background-color: var(--tn-surface-2);
    border: 0;
    border-radius: var(--tn-radius-sm);
    color: var(--tn-text);
    font: 500 16px/20px var(--tn-font);
    font-variant-numeric: var(--tn-tabular);
    height: var(--tn-control-h);
    padding: 0 var(--tn-space-3);
    width: 100%;
  }
  .date-time-selector input:focus {
    box-shadow: inset 0 0 0 2px var(--tn-accent);
    outline: none;
  }
`

/**
 * Transit · Bike · Drive as one segmented pill group (trip-form's
 * MetroModeSelector, multi-select as before). Its visually-hidden labels are
 * made visible here so each segment carries its name.
 */
export const MobileModeSegments = styled.div`
  fieldset.metro-mode-selector {
    background-color: var(--tn-surface);
    border-radius: var(--tn-radius-pill);
    box-shadow: var(--tn-shadow);
    display: flex;
    gap: var(--tn-space-1);
    margin: 0;
    padding: var(--tn-space-1);
    width: 100%;
  }
  fieldset.metro-mode-selector > span {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
  }
  fieldset.metro-mode-selector > span > label {
    align-items: center;
    aspect-ratio: auto;
    background-color: transparent;
    border: 0;
    border-radius: var(--tn-radius-pill);
    box-shadow: none;
    color: var(--tn-text-2);
    display: flex;
    flex: 1;
    font: 500 15px/20px var(--tn-font);
    gap: 6px;
    justify-content: center;
    margin: 0;
    min-height: var(--tn-tap);
    min-width: 0;
    padding: 0 var(--tn-space-2);
  }
  fieldset.metro-mode-selector > span > label:hover {
    background-color: var(--tn-surface-2);
    box-shadow: none;
  }
  fieldset.metro-mode-selector > span > label > svg {
    color: currentColor;
    fill: currentColor;
    flex: none;
    height: 20px;
    margin: 0;
    width: 20px;
  }
  fieldset.metro-mode-selector > span > label > span {
    clip: auto;
    height: auto;
    overflow: hidden;
    position: static;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: auto;
  }
  fieldset.metro-mode-selector > span > input:checked + label,
  fieldset.metro-mode-selector > span > input:checked + label:hover {
    background-color: var(--tn-accent-soft);
    color: var(--tn-accent);
    font-weight: 600;
  }
  fieldset.metro-mode-selector > span > input:checked + label > svg {
    color: var(--tn-accent);
    fill: var(--tn-accent);
  }
  fieldset.metro-mode-selector > span > input:focus-visible + label {
    outline: 2px solid var(--tn-accent);
    outline-offset: 0;
  }
  fieldset.metro-mode-selector
    > span
    > input:focus:not(:focus-visible)
    + label {
    outline: none;
  }
`

/** "Back to results" above "Plan trip", both full width. */
export const MobileActions = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--tn-space-2);
`
