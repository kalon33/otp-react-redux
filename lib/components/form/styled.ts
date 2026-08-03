import {
  DateTimeSelector,
  Styled as TripFormClasses
} from '@opentripplanner/trip-form'
import { Input, MenuItemLi } from '@opentripplanner/location-field/lib/styled'
import LocationField from '@opentripplanner/location-field'
import styled, { css } from 'styled-components'

import { blue, grey } from '../util/colors'
import { prefersReducedMotion } from '../util/prefersReducedMotion'

const commonButtonCss = css`
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  background: none;
  border: 1px solid rgb(187, 187, 187);
  border-radius: 3px;
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  outline-offset: -2px;
  padding: 6px 12px;
  text-align: center;
  touch-action: manipulation;
  user-select: none;

  &.active {
    background-color: var(--main-base-color, rgb(173, 216, 230));
    border: 2px solid rgb(0, 0, 0);
    box-shadow: inset 0 3px 5px rgba(0, 0, 0, 0.125);
    color: var(--main-color, white);
    font-weight: 600;
  }
`

export const commonInputCss = css`
  background: none;
  border: 1px solid ${blue[200]};
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.075);
  color: ${grey[800]};
  font-family: inherit;
  font-weight: inherit;
  padding: 6px 12px;
  transition: border-color ease-in-out 0.15s, box-shadow ease-in-out 0.15s;
`

export const modeButtonButtonCss = css`
  ${TripFormClasses.ModeButton.Button} {
    ${commonButtonCss}
  }
`

export const StyledDateTimeSelector = styled(DateTimeSelector)`
  font-size: 14px;
  div {
    max-width: 33%;
  }

  /*
    iOS auto-zooms any focused input rendered below 16px. In the app that zoom
    is now blocked outright (see the viewport meta in index.tpl.html), but
    mobile Safari ignores user-scalable=no, so on the browser build the rider
    still gets yanked in every time they tap the date. These two inputs are the
    only sub-16px text fields in the app — the location fields already render
    at 17px — so 16px here is the whole fix. It's the iOS threshold, not a
    design choice.

    The 33% cap was sized for 14px text and clips the date to "08/02/202" at
    16px on a 320px-wide screen, so it widens to suit. DateTimeSelector always
    renders exactly two divs (time, date), leaving 10% for the gap.
  */
  @media (pointer: coarse) {
    font-size: 16px;
    div {
      max-width: 45%;
    }
  }
`

export const UnpaddedList = styled.ul`
  padding: 0;
`

export const StyledLocationField = styled(LocationField)`
  display: grid;
  grid-template-columns: 30px 1fr 30px;
  width: 100%;

  input {
    padding: 6px 12px;
  }

  ${MenuItemLi} {
    &:hover {
      color: inherit;
    }
  }
`

export const advancedPanelClassName = 'advanced-panel'
export const mainPanelClassName = 'main-panel'
export const transitionDuration = prefersReducedMotion ? 0 : 175

const wipeOffset = 7

const transitionMixin = css`
  transition: all ${transitionDuration}ms ease-in-out;
`

const wipeOutMixin = (offset: number) => css`
  opacity: 0;
  transform: translateX(${offset}px);
`
const wipeInMixin = css`
  opacity: 1;
`

export const TransitionStyles = styled.div<{ transitionDelay: number }>`
  display: contents;
  .${advancedPanelClassName}-enter {
    ${wipeOutMixin(wipeOffset)}
  }
  .${advancedPanelClassName}-enter-done {
    ${wipeInMixin}
    ${transitionMixin}
  }

  .${advancedPanelClassName}-exit {
    ${wipeInMixin}
  }

  .${advancedPanelClassName}-exit-active {
    ${wipeOutMixin(wipeOffset)}
    ${transitionMixin}
    transition-delay: ${(props) => props.transitionDelay}ms;
  }

  .${mainPanelClassName}-enter {
    ${wipeOutMixin(-wipeOffset)}
  }
  .${mainPanelClassName}-enter-done {
    ${wipeInMixin}
    ${transitionMixin}
  }

  .${mainPanelClassName}-exit {
    ${wipeInMixin}
  }

  .${mainPanelClassName}-exit-active {
    ${wipeOutMixin(-wipeOffset)}
    ${transitionMixin}
  }
`
export const styledCheckboxCss = css`
  div {
    align-items: center;
    justify-content: space-between;

    label {
      margin-bottom: 0;
    }
    input[type='checkbox'] {
      margin-top: 0;
      order: 2;

      &:focus-visible + label {
        outline: 1px solid blue;
      }
    }
  }
`
