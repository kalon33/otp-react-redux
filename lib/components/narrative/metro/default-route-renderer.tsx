import { getMostReadableTextColor } from '@opentripplanner/core-utils/lib/route'
import { Leg } from '@opentripplanner/types'
import React, { CSSProperties } from 'react'
import styled from 'styled-components'

/**
 * The route pill: the GTFS route colour as a solid fill with its readable
 * text colour (the feed's route_text_color when it reads, else white or near
 * black by contrast), 26 px tall, radius-sm, 14 px 600 (mobile overhaul,
 * 2026-10-26 — it was a 10 % tint under a 5 px top border).
 *
 * On a background that is already the route colour (a viewer header) the
 * pill drops its fill and takes the surrounding text colour, as before.
 */
const Block = styled.span<{
  $color: string
  $textColor: string
  isOnColoredBackground?: boolean
}>`
  background-color: ${(props) => props.$color};
  border-radius: var(--tn-radius-sm);
  box-sizing: border-box;
  color: ${(props) => props.$textColor};
  display: inline-block;
  font: 600 14px/26px var(--tn-font);
  font-variant-numeric: var(--tn-tabular);
  height: 26px;
  letter-spacing: 0.01em;
  margin: 0;
  min-width: 26px;
  padding: 0 8px !important;
  text-align: center;
  /* Below is for route names that are too long: cut-off and show ellipsis. */
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  /* (Change the vertical alignment when changing the overflow attribute.) */
  vertical-align: middle;
  white-space: nowrap;

  ${(props) =>
    props.isOnColoredBackground &&
    `
    background-color: transparent;
    color: inherit;
    height: auto;
    line-height: inherit;
    padding: 0 !important;
    text-overflow: unset;
  `}
`

export type RouteRendererProps = {
  leg: Leg & { onColoredBackground?: boolean }
  style?: CSSProperties
}

const DefaultRouteRenderer = ({
  leg,
  style
}: RouteRendererProps): JSX.Element => {
  const route = typeof leg.route === 'object' ? leg.route : null
  const routeTitle = route
    ? route.shortName || route.longName
    : leg.routeShortName || leg.routeLongName
  const color = `#${(route ? route.color : leg.routeColor) || '333333'}`
  const proposedText = (route ? route.textColor : leg.routeTextColor) || ''
  return (
    <Block
      $color={color}
      $textColor={getMostReadableTextColor(
        color,
        proposedText ? `#${proposedText}` : '#ffffff'
      )}
      isOnColoredBackground={leg.onColoredBackground}
      style={style}
      title={routeTitle}
    >
      {routeTitle}
    </Block>
  )
}
export default DefaultRouteRenderer
