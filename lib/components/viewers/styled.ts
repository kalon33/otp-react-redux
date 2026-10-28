import styled from 'styled-components'

import { getBaseColor, grey } from '../util/colors'

interface RenderProps {
  backgroundColor?: string
  full?: boolean
  routeColor?: string
  textColor?: string
  useRouteColorAsBg?: boolean
}

/** Route Details */
export const Container = styled.div<RenderProps>`
  background-color: ${(props) =>
    props.full ? props.backgroundColor || grey[100] : 'inherit'};
  color: ${(props) => (props.full ? props.textColor : 'inherit')};
  height: 100%;
  overflow-y: hidden;

  .tn-mobile & {
    background-color: var(--tn-surface);
    color: var(--tn-text);
  }
`

export const RouteNameContainer = styled.div`
  padding: 8px;
  background-color: inherit;
`
export const LogoLinkContainer = styled.div<{
  textColor?: string
  useRouteBgColor?: boolean
}>`
  display: flex;
  border-top: 1px solid
    ${(props) => (props.useRouteBgColor ? props.textColor + '33' : '#33333333')};
  align-items: center;
  gap: 10px;
  padding: 15px 10px;
  margin-top: -10px;

  a {
    color: ${(props) => props.textColor};
    svg {
      color: ${(props) =>
        props.useRouteBgColor ? props.textColor : getBaseColor()};
    }
  }

  .tn-mobile & {
    border-top-color: var(--tn-border);
    font: var(--tn-type-sm);
    margin-top: 0;
    min-height: var(--tn-row-h);
    padding: var(--tn-space-2) var(--tn-space-4)
      calc(var(--tn-space-2) + var(--tn-safe-bottom));
  }
  .tn-mobile & a,
  .tn-mobile & a svg {
    color: var(--tn-accent);
  }
  .tn-mobile & a {
    align-items: center;
    display: inline-flex;
    min-height: var(--tn-tap);
  }
`
export const HeadsignSelectLabel = styled.label`
  font-size: 18px;
  margin-bottom: 0;
`

export const PatternContainer = styled.div`
  align-items: center;
  background-color: inherit;
  color: inherit;
  display: flex;
  justify-content: space-between;
  padding: 8px 10px;

  label {
    width: 15%;
  }

  // Styling for SortResultsDropdown

  & > span {
    width: 80%;

    button#headsign-selector-label {
      align-items: center;
      display: flex;
      justify-content: space-between;
      width: 95%;

      span {
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }
    }
  }
`

export const StopContainer = styled.ol<RenderProps>`
  color: ${(props) => props?.textColor};
  background-color: ${(props) => props?.backgroundColor};
  overflow-y: scroll;
  /* Calculate the height of the container a little short to ensure all stops 
  are shown when browsers don't calculate 100% sensibly. */
  height: calc(100% - 140px);
  padding: 15px 0 0px;

  .tn-mobile & {
    background-color: var(--tn-surface);
    color: var(--tn-text);
    margin: 0;
    overflow-y: auto;
    padding: 0 0 var(--tn-space-3);
  }
`
export const StopLink = styled.button<RenderProps>`
  color: ${(props) => props?.textColor + 'da'};
  background-color: transparent;
  border: none;
  padding: 0;
  text-align: left;
  width: 95%;

  &:hover {
    color: ${(props) => props?.textColor};
    text-decoration: underline;
  }

  /* Phone: the whole 44px row is the link; names 16px. */
  .tn-mobile & {
    color: var(--tn-text);
    font: var(--tn-type-body);
    min-height: var(--tn-tap);
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
  }
  .tn-mobile &:hover {
    color: var(--tn-text);
    text-decoration: none;
  }
`

export const Stop = styled.li<RenderProps>`
  cursor: pointer;
  display: block;
  white-space: nowrap;
  margin-left: 45px;
  /* negative margin accounts for the height of the stop blob */
  margin-top: -28px;

  /* this is the station blob */
  &::before {
    content: '';
    display: block;
    height: 20px;
    width: 20px;
    border: 5px solid
      ${(props) =>
        props.useRouteColorAsBg ? props.textColor + 'ee' : props.routeColor};
    background: ${(props) =>
      props.useRouteColorAsBg ? props.routeColor : '#fff'};
    position: relative;
    top: 20px;
    left: -35px;
    border-radius: 20px;
  }

  /* this is the line between the blobs */
  &::after {
    content: '';
    display: block;
    height: 1.65rem; /* set position in line-height agnostic way */
    width: 10px;
    background: ${(props) =>
      props.useRouteColorAsBg ? props.textColor + 'ee' : props.routeColor};
    position: relative;
    left: -30px;
    /* this is a few pixels into the blob (to make it look attached) + 3.5rem so that each
    stop's bar connects the previous bar with the current one */
    top: -3.5rem; /* adjust position in a way that is agnostic to line-height */
  }

  /* hide the first line between blobs */
  &:first-of-type::after {
    background: transparent;
  }

  /* Phone layout (mobile overhaul): the line as a 4px rail in the route
     colour with 12px stop nodes, one 44px row per stop. */
  .tn-mobile & {
    align-items: center;
    display: flex;
    margin: 0;
    min-height: var(--tn-tap);
    padding: 0 var(--tn-space-4) 0 48px;
    position: relative;
  }
  .tn-mobile &::before {
    background: var(--tn-surface);
    border: 3px solid ${(props) => props.routeColor};
    border-radius: 50%;
    box-sizing: border-box;
    height: 12px;
    left: 22px;
    margin-top: -6px;
    position: absolute;
    top: 50%;
    width: 12px;
    z-index: 2;
  }
  .tn-mobile &::after {
    background: ${(props) => props.routeColor};
    bottom: 0;
    height: auto;
    left: 26px;
    position: absolute;
    top: 0;
    width: 4px;
  }
  .tn-mobile &:first-of-type::after {
    background: ${(props) => props.routeColor};
    top: 50%;
  }
  .tn-mobile &:last-of-type::after {
    bottom: 50%;
  }
  .tn-mobile &:first-of-type::before,
  .tn-mobile &:last-of-type::before {
    background: ${(props) => props.routeColor};
  }
`

export const PatternRowItem = styled.li`
  list-style-type: none;

  & .header {
    align-items: center;
    background-color: var(--pattern-route-color);
    color: var(--pattern-route-text);
    display: grid;
    grid-template-columns: 2fr 1fr;
    overflow: hidden;
  }

  /* Phone layout (mobile overhaul): a list row — route pill in the GTFS
     colour, headsign 16px, the next departures right-aligned. */
  .tn-mobile & .header {
    background-color: var(--tn-surface);
    box-shadow: inset 0 1px 0 var(--tn-border);
    color: var(--tn-text);
    column-gap: var(--tn-space-3);
    display: flex;
    min-height: 60px;
    padding: var(--tn-space-3) var(--tn-space-4);
  }
  .tn-mobile & .route-name {
    align-items: center;
    display: flex;
    flex: 1 1 45%;
    gap: var(--tn-space-3);
    min-width: 0;
    padding: 0;
  }
  .tn-mobile & .route-name-container {
    align-items: center;
    display: inline-flex;
    flex: none;
    gap: var(--tn-space-1);
  }
  .tn-mobile & .route-name-container > span[title] {
    background: var(--pattern-route-color);
    border: 0;
    border-radius: var(--tn-radius-sm);
    color: var(--pattern-route-text);
    font: 700 15px/20px var(--tn-font) !important;
    margin: 0;
    max-width: 128px;
    min-width: 36px;
    padding: 3px 8px !important;
    text-align: center;
  }
  .tn-mobile & .route-name > span:last-child {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: var(--tn-text);
    display: -webkit-box;
    font: 400 16px/20px var(--tn-font);
    overflow: hidden;
  }
`

export const NextTripPreview = styled.ol`
  display: grid;
  grid-template-rows: fit-content(8ch);
  list-style-type: none;
  padding: 15px;
  text-align: right;
  white-space: nowrap;

  & li:first-of-type {
    font-size: 24px;
    font-weight: 700;
  }

  /* Phone: the next departure 17px 600, the two after it 13px under it
     (inline items in a right-aligned block, so the column is only as wide
     as its longest line). */
  .tn-mobile & {
    display: block;
    flex: 0 1 auto;
    font-variant-numeric: var(--tn-tabular);
    margin: 0;
    max-width: 55%;
    padding: 0;
    text-align: right;
    white-space: normal;
  }
  .tn-mobile & .day-label {
    color: var(--tn-text-2);
    display: block;
    font: var(--tn-type-xs);
    opacity: 1;
  }
  .tn-mobile & li {
    color: var(--tn-text-2);
    display: inline;
    white-space: nowrap;
    font: 400 13px/18px var(--tn-font);
    font-variant-numeric: var(--tn-tabular);
  }
  /* inline-block, so the line may break between two departures */
  .tn-mobile & li + li {
    display: inline-block;
  }
  .tn-mobile & li > div {
    display: inline;
  }
  .tn-mobile & li:first-of-type {
    color: var(--tn-text);
    display: block;
    font: var(--tn-type-lg);
    font-variant-numeric: var(--tn-tabular);
  }
  .tn-mobile & li:first-of-type > div {
    display: block;
  }
  .tn-mobile & li + li + li {
    margin-left: var(--tn-space-2);
  }
`
