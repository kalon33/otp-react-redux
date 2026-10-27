/**
 * Go Mode styles (mobile overhaul 2026-10-26: every colour is a design token).
 *
 * Go Mode renders OUTSIDE `.otp` — a fixed full-screen layer — so nothing in
 * lib/styles/base.css reaches it and nothing here may hard-code a light
 * colour: the dark tokens switch on under `html.tn-mobile`, and a literal
 * white here is white-on-white in dark mode. Values come from
 * lib/styles/tokens.css; the pill / chip / grabber recipes are the shared
 * primitives in lib/components/util/tn-styled.ts. GTFS route colours are the
 * one exception: they arrive as props and are painted as the agency publishes
 * them (route pills, the card's left stripe, the ride progress bar).
 *
 * Export names, transient props and the class names/attributes that
 * scripts/verify-*.js and __tests__ hook into are unchanged.
 */
import styled, { css, keyframes } from 'styled-components'

import {
  tnButtonCss,
  TnChip,
  TnSheetGrabber,
  tnTabular
} from '../util/tn-styled'

// Shared animations
const pulseOpacity = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.8;
  }
`

/* ------------------------------------------------------------------ */
/* Route colours                                                       */

/** A GTFS colour ("0053A0" or "#0053A0") as CSS, or null when absent. */
export function gtfsColor(value?: string | null): string | null {
  if (!value || typeof value !== 'string') return null
  const hex = value.replace(/^#/, '').trim()
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex) ? `#${hex}` : null
}

/**
 * The pill colours for a transit leg: its GTFS route colour with its route
 * text colour (white when the feed names none). A leg with no route colour
 * gets the brand accent pill, so every pill reads in both themes.
 */
export function routePillColors(
  leg?: { routeColor?: string | null; routeTextColor?: string | null } | null
): { bg: string; fg: string } {
  const bg = gtfsColor(leg?.routeColor)
  if (!bg) return { bg: 'var(--tn-accent)', fg: 'var(--tn-accent-ink)' }
  return { bg, fg: gtfsColor(leg?.routeTextColor) || '#ffffff' }
}

/* ------------------------------------------------------------------ */
/* Shared pill buttons (tnButtonCss with a fixed variant)              */

const primaryPill = css`
  ${tnButtonCss}
  background-color: var(--tn-accent);
  color: var(--tn-accent-ink);
`

const secondaryPill = css`
  ${tnButtonCss}
  background-color: var(--tn-surface-2);
  color: var(--tn-text);
`

const ghostPill = css`
  ${tnButtonCss}
  background-color: transparent;
  color: var(--tn-accent);
  min-height: var(--tn-tap);
  padding: 0 var(--tn-space-3);

  &:active:not(:disabled) {
    background-color: var(--tn-accent-soft);
    filter: none;
  }
`

/** A status chip (not a button): 28px pill, 13px 600. */
const statusChip = css`
  align-items: center;
  border-radius: var(--tn-radius-pill);
  display: inline-flex;
  font: 600 13px/18px var(--tn-font);
  gap: 6px;
  max-width: 100%;
  min-height: 28px;
  padding: 4px 10px;
`

// GoModeHeader styles
export const HeaderContainer = styled.div`
  background-color: var(--tn-surface);
  border-bottom: 1px solid var(--tn-border);
  padding: 12px 16px;
`

/** Ride progress: a 6px rounded track, the fill in the route colour. */
export const ProgressBarTrack = styled.div`
  background-color: var(--tn-border);
  border-radius: var(--tn-radius-pill);
  height: 6px;
  margin-top: var(--tn-space-3);
  overflow: hidden;
  width: 100%;
`

export const ProgressBarFill = styled.div<{
  $color: string
  $width: number
}>`
  background-color: ${(props) => props.$color};
  border-radius: var(--tn-radius-pill);
  height: 100%;
  transition: width 0.3s ease;
  width: ${(props) => props.$width}%;
`

export const HeaderRow = styled.div`
  align-items: center;
  display: flex;
  justify-content: space-between;
  min-width: 0;
  overflow: hidden;
`

export const ETAValue = styled.div<{ $color?: string }>`
  color: ${(props) => props.$color || 'inherit'};
  font: 700 24px/28px var(--tn-font);
  ${tnTabular}
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const ETALabel = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const TimeRemainingValue = styled.div`
  font: 600 18px/22px var(--tn-font);
  ${tnTabular}
`

export const StatusBadge = styled.div<{ $color: string }>`
  background-color: ${(props) => props.$color};
  border-radius: var(--tn-radius-sm);
  color: #fff;
  font: var(--tn-type-xs);
  margin-top: 8px;
  padding: 6px 12px;
  text-align: center;
`

// CurrentLegPanel styles — the strip above the map that holds the card. The
// card's shadow needs the panel's padding to show, so the panel is the page
// ground and the card is the surface.
export const LegPanelContainer = styled.div`
  background-color: var(--tn-bg);
  flex: 0 0 auto;
  max-height: 50%;
  overflow-y: auto;
`

// TransitProgress styles
export const TransitContainer = styled.div`
  padding: var(--tn-space-2) var(--tn-space-3) var(--tn-space-3);
`

export const RouteHeader = styled.div`
  align-items: center;
  display: flex;
  margin-bottom: 8px;
  min-width: 0;
  overflow: hidden;
`

export const ModeIcon = styled.span`
  font-size: 32px;
  margin-right: 12px;
`

export const RouteName = styled.div`
  color: var(--tn-text);
  font: var(--tn-type-lg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const RouteDirection = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-body);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/**
 * GET READY. Urgent is the one solid-danger surface in Go Mode; the 2-stops
 * warning is a warn tint with a warn stripe (a solid amber fails contrast
 * with white text in both themes).
 */
export const AlertBanner = styled.div<{ $severity: 'urgent' | 'warning' }>`
  animation: ${pulseOpacity} 1s ease-in-out infinite;
  border-radius: var(--tn-radius-sm);
  font: 700 16px/22px var(--tn-font);
  margin-top: var(--tn-space-3);
  overflow-wrap: break-word;
  padding: var(--tn-space-3) var(--tn-space-4);
  text-align: center;
  word-wrap: break-word;
  ${(props) =>
    props.$severity === 'urgent'
      ? css`
          background-color: var(--tn-danger);
          color: var(--tn-surface);
        `
      : css`
          background-color: var(--tn-warn-soft);
          box-shadow: inset 4px 0 0 var(--tn-warn);
          color: var(--tn-text);
        `}
`

/**
 * The ride hero, "4 stops remaining": the count at hero size, the word after
 * it at the card's primary-line size, on one baseline.
 */
export const StopsHero = styled.div`
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--tn-space-2);
  margin-top: var(--tn-space-1);
  min-width: 0;
`

export const StopsCount = styled.span<{ $alert: boolean }>`
  color: ${(props) => (props.$alert ? 'var(--tn-danger)' : 'var(--tn-text)')};
  font: var(--tn-type-hero);
  letter-spacing: -0.02em;
  ${tnTabular}
  white-space: nowrap;
`

export const StopsLabel = styled.span`
  color: var(--tn-text-2);
  font: var(--tn-type-lg);
`

/** "Next stop: Lake St Station" under the ride hero. */
export const NextStopLine = styled.div`
  color: var(--tn-text);
  font: var(--tn-type-lg);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** A wrapping row of status chips under the hero. */
export const StatusChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--tn-space-2);
  margin-top: var(--tn-space-3);

  &:empty {
    display: none;
  }
`

export const InfoCard = styled.div<{
  $bgColor?: string
  $textColor?: string
}>`
  background-color: ${(props) => props.$bgColor || 'var(--tn-surface-2)'};
  border-radius: var(--tn-radius-sm);
  margin-bottom: 12px;
  padding: 12px;

  ${(props) =>
    props.$textColor &&
    css`
      color: ${props.$textColor};
    `}
`

export const InfoCardLabel = styled.div<{ $color?: string }>`
  color: ${(props) => props.$color || 'var(--tn-text-2)'};
  font: var(--tn-type-xs);
  margin-bottom: 4px;
`

export const InfoCardValue = styled.div<{
  $color?: string
}>`
  font: 500 16px/22px var(--tn-font);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  ${(props) =>
    props.$color &&
    css`
      color: ${props.$color};
    `}
`

// WalkingNavigation styles
export const WalkingContainer = styled.div`
  padding: var(--tn-space-2) var(--tn-space-3) var(--tn-space-3);
`

export const DistanceDisplay = styled.div`
  color: var(--tn-accent);
  font: 700 24px/28px var(--tn-font);
  ${tnTabular}
`

// --- Single navigation card (access leg → transit, and the ride) ----------
// One card that states the facts directly: when the bus arrives and how long
// the ride to the stop is. No "leave in" computation — the rider deduces that
// themselves. Surface, radius 16, shadow, and a 4px LEFT stripe in the route
// colour (the accent on a walk/bike-only leg). The stripe is an inset shadow
// so it follows the rounded corner without overflow: hidden.
export const NavCard = styled.div<{ $stripe?: string }>`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: inset 4px 0 0 ${(p) => p.$stripe || 'var(--tn-accent)'},
    var(--tn-shadow);
  color: var(--tn-text);
  padding: var(--tn-space-1) var(--tn-space-4) var(--tn-space-3)
    calc(var(--tn-space-4) + 4px);
`

// Back arrow inline in the card's eyebrow row: a 44px target whose glyph sits
// flush with the card's text edge (the negative margin eats the padding).
export const CardBackButton = styled.button`
  align-items: center;
  appearance: none;
  background: none;
  border: none;
  border-radius: var(--tn-radius-pill);
  color: var(--tn-text);
  cursor: pointer;
  display: inline-flex;
  flex-shrink: 0;
  font-size: 22px;
  height: var(--tn-tap);
  justify-content: center;
  line-height: 1;
  margin: 0 0 0 -12px;
  padding: 0;
  width: var(--tn-tap);

  &:active {
    background-color: var(--tn-surface-2);
  }
  &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: -2px;
  }
`

// Row holding the back arrow, the route pill and the headsign on one line.
export const NavEyebrowRow = styled.div`
  align-items: center;
  display: flex;
  gap: var(--tn-space-2);
  min-height: var(--tn-tap);
  min-width: 0;
`

export const NavEyebrow = styled.div`
  color: var(--tn-text-2);
  flex: 1;
  font: 600 15px/20px var(--tn-font);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** The route as the agency paints it, in the card's eyebrow row. */
export const NavRoutePill = styled.span<{ $bg: string; $fg: string }>`
  align-items: center;
  background-color: ${(p) => p.$bg};
  border-radius: 6px;
  color: ${(p) => p.$fg};
  display: inline-flex;
  flex: 0 1 auto;
  font: 700 15px/20px var(--tn-font);
  max-width: 60%;
  min-height: 26px;
  overflow: hidden;
  padding: 3px 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const NavHero = styled.div`
  color: var(--tn-text);
  font: var(--tn-type-hero);
  letter-spacing: -0.02em;
  ${tnTabular}
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  /* The live glyph beside a 40px time: the search UI's glyph at its own
     size (scaling it gets clipped by the hero's overflow), set off the time
     and lifted to the middle of the digits. */
  & > span::before {
    margin-right: 6px;
    vertical-align: 0.15em;
  }
`

export const NavSub = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-body);
  ${tnTabular}
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

// Realtime cue, copied verbatim from the search UI so Go Mode matches it
// exactly: a pulsing pair of radiating "waves" rendered as a ::before glyph
// immediately to the LEFT of the time, green, 7x14, no margin, dipping to 0.5
// opacity on a 2s pulse. See lib/components/narrative/default/itinerary.css
// ".realtime::before" — this is the same mechanism, glyph, size, and timing,
// in the realtime token (--tn-live) so it reads on a dark card too.
// Convention: glyph == live, no glyph == scheduled (the time itself is not
// recolored, just as in search).
const pulseRealtime = keyframes`
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
`

export const RealtimeTimeBox = styled.span<{ $live?: boolean }>`
  ${(props) =>
    props.$live &&
    css`
      &::before {
        animation: ${pulseRealtime} 2s ease-in-out infinite;
        background: var(--tn-live, rgb(0, 180, 0));
        clip-path: path(
          'M3.7,4.1C3.1,4.9,3,6,3.4,7.2c0.1,0.3,0.5,0.6,0.8,0.6c0.3,0,0.5-0.2,0.4-0.5C4.3,6.4,4.4,5.5,4.9,4.9s1.2-1,2.2-1 c0.1,0,0.3-0.1,0.3-0.1c0.1-0.1,0.1-0.3,0-0.4C7.3,3,6.9,2.8,6.6,2.8C5.3,2.8,4.3,3.2,3.7,4.1z M5.6,0C3.5-0.1,1.8,0.7,0.8,2 s-1.1,3.2-0.3,5.2C0.6,7.5,1,7.8,1.3,7.8c0.3,0,0.5-0.2,0.4-0.5C1,5.6,1.1,4,2,2.8s2.3-1.8,4.1-1.7c0.2,0,0.3-0.1,0.3-0.1 c0.1-0.1,0.1-0.2,0-0.4C6.3,0.3,5.9,0,5.6,0z'
        );
        content: '';
        display: inline-block;
        height: 14px;
        width: 7px;
      }
    `}
`

// "Go Mode is live" over the onboard results list: a live-tint pill with a
// pulsing dot to read as live tracking.
const pulseDot = keyframes`
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
`

const liveDot = css`
  &::before {
    animation: ${pulseDot} 2s ease-in-out infinite;
    background: var(--tn-live);
    border-radius: 50%;
    content: '';
    display: inline-block;
    flex: none;
    height: 8px;
    width: 8px;
  }
`

export const GoModeLiveBanner = styled.div`
  align-items: center;
  align-self: center;
  background-color: var(--tn-live-soft);
  /* A pill on one line; 18px keeps the shape when 360 px wraps it. */
  border-radius: 18px;
  color: var(--tn-text);
  display: inline-flex;
  font: 600 14px/18px var(--tn-font);
  gap: 8px;
  justify-content: center;
  margin: var(--tn-space-3) var(--tn-space-4) 0;
  max-width: calc(100% - 32px);
  min-height: 32px;
  overflow-wrap: break-word;
  padding: 6px 14px;
  text-align: center;
  word-wrap: break-word;

  ${liveDot}
`

// Scroll container for the onboard results list (ScreenMain clips overflow).
export const OnboardResultsScroll = styled.div`
  -webkit-overflow-scrolling: touch;
  background-color: var(--tn-bg);
  color: var(--tn-text);
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--tn-safe-bottom);
`

/** The onboard flow's question, "Where do you want to get off?". */
export const AlightTitle = styled.h2`
  color: var(--tn-text);
  font: var(--tn-type-title);
  margin: var(--tn-space-4) var(--tn-space-4) var(--tn-space-1);
`

// Up to two lines: the stop name in "6 min walk to Lake St & Hennepin Ave" is
// the part the rider needs, and one line cut it off at 360-390 px.
export const NavFoot = styled.div`
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--tn-text);
  display: -webkit-box;
  font: var(--tn-type-body);
  ${tnTabular}
  margin-top: 10px;
  overflow: hidden;
`

// A turn line with its arrow (44.3): the arrow sits left of the words, and
// the words keep their own NavSub / NavFoot type. The row takes over the
// line's top margin so the arrow and the text share one baseline box.
export const NavTurnRow = styled.div<{ $foot?: boolean }>`
  align-items: center;
  display: flex;
  gap: 10px;
  margin-top: ${(props) => (props.$foot ? '10px' : '6px')};
  min-width: 0;

  & > ${NavSub}, & > ${NavFoot} {
    align-items: baseline;
    color: var(--tn-text);
    display: flex;
    flex: 1;
    font: 600 16px/21px var(--tn-font);
    margin-top: 0;
    min-width: 0;
    white-space: normal;
  }
`

// The words of a turn line beside its arrow: up to two lines, so a long
// street name wraps instead of pushing the distance off the card (the 360 and
// 390 px review shots cut "· 295 ft" to "· 2…" when it was one line).
export const TurnWords = styled.span`
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  display: -webkit-box;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
`

// …and the distance, which never shrinks or truncates: it is the number the
// rider acts on.
export const TurnDistance = styled.span`
  flex: none;
  padding-left: 4px;
  ${tnTabular}
  white-space: nowrap;
`

// The arrow itself: big enough to read at a glance from the handlebars (44.3
// sized it 40px for exactly that), in the accent. The icon set's SVGs carry
// no fill of their own, so they take this colour.
export const TurnArrowBox = styled.span`
  color: var(--tn-accent);
  display: inline-flex;
  flex: none;
  height: 40px;
  width: 40px;

  svg {
    fill: currentColor;
    height: 100%;
    width: 100%;
  }
`

// Secondary strip at the card bottom for rare controls (alternate departures,
// reset-to-planned, "I got off here"). Only rendered when relevant.
export const NavExtras = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--tn-space-2);
  margin-top: var(--tn-space-2);

  /* Departure rows and wrapped link groups take the full width; the bare
     ghost pills ("I got off here", "Back to … (planned)") sit in a row. */
  & > div {
    flex: 1 1 100%;
  }
`

// The "Next:" strip: an inset surface-2 row inside the card.
export const AlternativeDeparture = styled.div`
  align-items: center;
  background-color: var(--tn-surface-2);
  border-radius: var(--tn-radius-sm);
  color: var(--tn-text);
  display: flex;
  ${tnTabular}
  justify-content: space-between;
  margin-top: 8px;
  min-height: var(--tn-tap);
  min-width: 0;
  overflow: hidden;
  padding: 0 4px 0 12px;
`

export const UseNextButton = styled.button`
  ${tnButtonCss}
  background-color: var(--tn-accent-soft);
  color: var(--tn-accent);
  flex-shrink: 0;
  font-size: 14px;
  margin-left: 8px;
  min-height: 36px;
  padding: 0 14px;
  position: relative;

  /* 36px pill, 44px touch area (same trade as TnChip). */
  &::after {
    bottom: -4px;
    content: '';
    left: 0;
    position: absolute;
    right: 0;
    top: -4px;
  }
`

/** Quiet accent control: a ghost pill, 44px tall, no underline. */
export const ResetButton = styled.button`
  ${ghostPill}
  flex: none;
  font-size: 15px;
  margin-left: -12px;
`

// GoModeMap styles
export const MapContainer = styled.div`
  flex: 1 1 40%;
  min-height: 250px;
  position: relative;
`

export const DeviationWarning = styled.div`
  background-color: var(--tn-warn-soft);
  border-radius: var(--tn-radius-pill);
  box-shadow: inset 0 0 0 1px var(--tn-warn), var(--tn-shadow);
  color: var(--tn-text);
  font: 600 14px/18px var(--tn-font);
  left: 50%;
  max-width: calc(100% - 20px);
  overflow-wrap: break-word;
  padding: 8px 16px;
  position: absolute;
  top: 10px;
  transform: translateX(-50%);
  word-wrap: break-word;
  z-index: 1001;
`

// GoModeScreen styles
export const FullScreenWrapper = styled.div`
  background-color: var(--tn-bg);
  bottom: 0;
  color: var(--tn-text);
  display: flex;
  flex-direction: column;
  font-family: var(--tn-font);
  left: 0;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 1000;

  /* MobileNavigationBar renders outside .otp context, so neither its CSS nor
     base.css's app bar applies. Slim it into a compact strip on the page
     ground with 44px menu/back targets and the trip's destination as a live
     pill, instead of the tall app bar. */
  > header {
    height: var(--tn-tap) !important;
  }

  .mobile-navbar-container {
    background: transparent;
    border: none;
    box-shadow: none;
    margin: 0;
    min-height: var(--tn-tap);
  }

  /* Bootstrap floats the brand and pulls the header block 15px left, which
     buries the menu icon under the title (and off the screen edge). Lay the
     strip out as a plain row instead: icon, back arrow, then the title. */
  .mobile-navbar-container .container-fluid {
    align-items: center;
    display: flex;
    padding: 0 var(--tn-space-1);
  }

  .mobile-navbar-container .navbar-header {
    margin: 0;
  }

  /* Strip the heavy default button chrome so the arrow reads as just an arrow. */
  .mobile-back {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--tn-radius-pill);
    box-shadow: none;
    color: var(--tn-text);
    display: inline-flex;
    height: var(--tn-tap);
    justify-content: center;
    padding: 0;
    width: var(--tn-tap);
  }
  .mobile-back svg {
    height: 20px;
    width: 20px;
  }

  /* Menu icon and back arrow share the left end of the strip. */
  .navbar-brand {
    align-items: center;
    display: flex;
    float: none;
    height: var(--tn-tap);
    margin: 0;
    padding: 0;
  }

  /* The hamburger: base.css's recipe (a 44px target drawing three 2px lines),
     repeated because base.css scopes it to .otp.mobile. */
  .app-menu-icon {
    border-radius: var(--tn-radius-pill);
    box-sizing: border-box;
    color: var(--tn-text);
    height: var(--tn-tap);
    margin: 0;
    padding: 14px 12px;
    width: var(--tn-tap);
  }

  /* The icon's bars are white for the app's dark nav bar; here they take the
     text colour, so they read on the page ground in both themes. */
  .app-menu-icon .menu-line {
    border-bottom: 2px solid var(--tn-text);
  }

  .app-menu-icon:active,
  .mobile-back:active {
    background-color: var(--tn-surface-2);
  }

  /* Account/locale controls are noise during turn-by-turn navigation. */
  .locale-selector-and-login {
    display: none;
  }

  .navbar .mobile-header {
    align-items: center;
    display: flex;
    flex: 1;
    height: var(--tn-tap);
    justify-content: flex-start;
    min-width: 0;
    overflow: hidden;
    padding: 0 var(--tn-space-2) 0 var(--tn-space-1);
    text-align: left;
  }

  /* The trip's destination as a live-tint pill: Go Mode is running. */
  .mobile-header-text {
    align-items: center;
    background-color: var(--tn-live-soft);
    border-radius: var(--tn-radius-pill);
    color: var(--tn-text);
    display: inline-flex;
    font: 600 15px/20px var(--tn-font) !important;
    gap: 8px;
    margin: 0;
    max-width: 100%;
    min-width: 0;
    padding: 5px 12px;
    width: auto;

    ${liveDot}
  }
  .mobile-header-text:empty {
    display: none;
  }

  /* The pill's text: ellipsis rather than wrap. */
  .mobile-header-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

export const ScreenMain = styled.main`
  background-color: var(--tn-bg);
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding-top: env(safe-area-inset-top, 0);
  position: relative;
`

export const LoadingMessage = styled.main`
  color: var(--tn-text);
  font: var(--tn-type-body);
  padding: 20px;
  text-align: center;
`

export const ErrorMessage = styled.p`
  color: var(--tn-danger);
  font: var(--tn-type-body);
  margin-bottom: 16px;
`

export const RetryButton = styled.button`
  ${primaryPill}
`

export const GpsWarningBanner = styled.div`
  background-color: var(--tn-warn-soft);
  box-shadow: inset 4px 0 0 var(--tn-warn);
  color: var(--tn-text);
  font: 500 14px/18px var(--tn-font);
  overflow-wrap: break-word;
  padding: 11px 16px;
  text-align: center;
  word-wrap: break-word;
`

// Live re-route (Go Mode) styles
export const RerouteBar = styled.div`
  bottom: calc(12px + var(--tn-safe-bottom));
  left: 12px;
  position: absolute;
  right: 12px;
  z-index: 1100;
`

/** "Search from here": the sheet's own full-width secondary action. */
export const RerouteButton = styled.button`
  ${secondaryPill}
  color: var(--tn-accent);
  display: flex;
  width: 100%;
`

export const RerouteCard = styled.div`
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: var(--tn-shadow);
  color: var(--tn-text);
  padding: var(--tn-space-4);
`

export const RerouteCardTitle = styled.div`
  color: var(--tn-text);
  font: 700 20px/26px var(--tn-font);
  margin-bottom: 4px;
  overflow-wrap: break-word;
`

export const RerouteSummary = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-body);
  ${tnTabular}
  margin-bottom: var(--tn-space-4);
`

// Two pills side by side (Switch + Keep mine), each taking half the card. The
// padding is tighter than a lone pill's so "Confirm this stop" + "Back to
// options" both fit at 360 px.
export const RerouteActions = styled.div`
  display: flex;
  gap: var(--tn-space-2);

  & > button {
    flex: 1 1 0;
    font-size: 15px;
    line-height: 20px;
    min-width: 0;
    padding: 6px var(--tn-space-3);
    white-space: normal;
  }
`

export const RerouteSwitchButton = styled.button`
  ${primaryPill}
  flex: 1;
`

export const RerouteKeepButton = styled.button`
  ${secondaryPill}
  flex: 1;
`

// The faster-route card (56.1): the Reroute* card, lifted clear of the
// "View trip & other ways" grabber it sits above (~50 px tall plus the safe
// area), with Keep mine as the secondary pill beside the primary Switch.
export const FasterRouteBar = styled(RerouteBar)`
  bottom: calc(62px + var(--tn-safe-bottom));
`

export const FasterRouteText = styled.div`
  cursor: pointer;
`

export const FasterRouteDetail = styled(RerouteSummary)`
  overflow-wrap: break-word;
`

export const FasterRouteKeepButton = styled(RerouteKeepButton)``

// Dev simulation toolbar styles (dev builds only; deliberately its own dark
// chrome in both themes so it never reads as part of the trip UI).
export const SimToolbar = styled.div`
  background: #263238;
  border-top: 2px solid #37474f;
  bottom: 0;
  color: #eceff1;
  display: flex;
  flex-wrap: wrap;
  font-size: 12px;
  gap: 6px;
  left: 0;
  padding: 8px 12px;
  position: absolute;
  right: 0;
  z-index: 2000;
`

export const SimButton = styled.button<{
  $variant?: 'start' | 'stop' | 'pause' | 'resume'
}>`
  background-color: ${(props) => {
    switch (props.$variant) {
      case 'start':
        return '#4CAF50'
      case 'stop':
        return '#F44336'
      case 'pause':
        return '#FF9800'
      case 'resume':
        return '#2196F3'
      default:
        return '#607D8B'
    }
  }};
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;

  &:active {
    opacity: 0.8;
  }
`

export const SimSpeedSelect = styled.select`
  background: #37474f;
  border: 1px solid #546e7a;
  border-radius: 4px;
  color: #eceff1;
  font-size: 12px;
  padding: 4px 6px;
`

export const SimProgress = styled.span`
  align-items: center;
  color: #90a4ae;
  display: flex;
  font-size: 11px;
  margin-left: auto;
`

export const SimToggle = styled.button`
  background: none;
  border: none;
  color: #90a4ae;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 6px;
  position: absolute;
  right: 4px;
  top: -18px;
  z-index: 2001;

  &:hover {
    color: #eceff1;
  }
`

// Boarding prompt styles
const slideUp = keyframes`
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
`

export const BoardingOverlay = styled.div`
  background: var(--tn-scrim);
  bottom: 0;
  left: 0;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 3000;
`

// $expanded mirrors the results screen's expand-map/show-results toggle: the
// sheet sits over the live map, so shrinking it is how the rider gets the map
// back (and how a tapped leg's zoom becomes visible). Omitting the prop keeps
// the original fixed height — BoardingPrompt shares this sheet and doesn't
// toggle. The ::before is the sheet's grabber bar (decorative).
export const BoardingSheet = styled.div<{ $expanded?: boolean }>`
  animation: ${slideUp} 0.3s ease-out;
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius) var(--tn-radius) 0 0;
  bottom: 0;
  box-shadow: var(--tn-shadow-up);
  color: var(--tn-text);
  font-family: var(--tn-font);
  left: 0;
  max-height: ${(p) =>
    p.$expanded === undefined ? '70vh' : p.$expanded ? '85vh' : '40vh'};
  overflow-y: auto;
  padding: var(--tn-space-2) var(--tn-space-4)
    calc(var(--tn-space-5) + var(--tn-safe-bottom));
  position: fixed;
  right: 0;
  transition: max-height 300ms;
  z-index: 3001;

  &::before {
    background-color: var(--tn-text-3);
    border-radius: var(--tn-radius-pill);
    content: '';
    display: block;
    height: 5px;
    margin: 0 auto var(--tn-space-2);
    opacity: 0.6;
    width: 36px;
  }
`

export const BoardingTitle = styled.h3`
  color: var(--tn-text);
  flex: 1;
  font: var(--tn-type-title);
  margin: 0 0 4px;
  min-width: 0;
`

export const BoardingSubtitle = styled.p`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  margin: 0 0 16px;
`

export const VehicleOptionRow = styled.div`
  align-items: center;
  background-color: var(--tn-surface-2);
  border: 1px solid transparent;
  border-radius: var(--tn-radius-sm);
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 12px;
`

export const VehicleInfo = styled.div`
  flex: 1;
  min-width: 0;
`

export const VehicleLabel = styled.div`
  align-items: center;
  color: var(--tn-text);
  display: flex;
  font: 600 16px/22px var(--tn-font);
  gap: 8px;
  min-width: 0;
`

/** The route as the agency paints it. Most local routes share one purple, so
 * the NUMBER carries the identity and the color is confirmation — only the
 * METRO lines are distinguishable by color alone. */
export const RouteBadge = styled.span<{ $bg: string; $fg: string }>`
  background-color: ${(props) => props.$bg};
  border-radius: 6px;
  color: ${(props) => props.$fg};
  /* The badge IS the identity — it keeps its full width and the direction
     beside it gives way first. "METRO Orange Li…" helps nobody. */
  flex: 0 0 auto;
  font: 700 15px/20px var(--tn-font);
  overflow: hidden;
  padding: 3px 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const VehicleDetail = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const VehicleSelectButton = styled.button`
  ${primaryPill}
  flex-shrink: 0;
  font-size: 15px;
  margin-left: 12px;
  /* A thumb-sized target (51.1). */
  min-height: var(--tn-tap);
  padding: 0 var(--tn-space-4);
`

export const BoardingDismissButton = styled.button`
  ${secondaryPill}
  display: flex;
  margin-top: 8px;
  width: 100%;
`

/**
 * "On a different bus?" under the waiting and access cards (51.1). The same
 * quiet accent control as the card's other ones (ResetButton), with a
 * thumb-sized hit area — the rider reaches for it on a moving bus.
 */
export const ChooseBusLink = styled(ResetButton)`
  align-items: center;
  display: inline-flex;
  font-size: 14px;
  min-height: var(--tn-tap);
`

/** Section line inside the choose-bus sheet (51.1). */
export const ChooseBusSection = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-xs);
  letter-spacing: var(--tn-tracking-xs);
  margin: 16px 0 8px;
  text-transform: uppercase;
`

/** The nearby routes as tappable badges, wrapped (51.1). */
export const RouteBadgeGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
`

/** A route badge (RouteBadge's look) that is itself the button (51.1). */
export const RouteBadgeButton = styled.button<{ $bg: string; $fg: string }>`
  background-color: ${(props) => props.$bg};
  border: none;
  border-radius: var(--tn-radius-sm);
  color: ${(props) => props.$fg};
  cursor: pointer;
  font: 700 15px/20px var(--tn-font);
  max-width: 100%;
  min-height: var(--tn-tap);
  min-width: 56px;
  overflow: hidden;
  padding: 0 12px;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:active {
    opacity: 0.8;
  }
`

/** "Type a route number" row: the box and its button (51.1). */
export const RouteNumberForm = styled.form`
  align-items: center;
  display: flex;
  gap: var(--tn-space-2);
  margin-top: 4px;
`

export const RouteNumberInput = styled.input`
  background-color: var(--tn-surface-2);
  border: 0;
  border-radius: var(--tn-radius-sm);
  color: var(--tn-text);
  flex: 1 1 auto;
  /* 16px: iOS zooms the page into any smaller input on focus. */
  font: 400 16px/22px var(--tn-font);
  min-height: var(--tn-control-h);
  min-width: 0;
  padding: 0 12px;

  &::placeholder {
    color: var(--tn-text-3);
  }
`

// Vehicle tracking badge: a status chip, live tint once the rider is on the
// bus, accent tint while the bus is only being tracked.
export const VehicleTrackingBadge = styled.div<{ $confirmed: boolean }>`
  ${statusChip}
  background-color: ${(props) =>
    props.$confirmed ? 'var(--tn-live-soft)' : 'var(--tn-accent-soft)'};
  color: ${(props) =>
    props.$confirmed ? 'var(--tn-live)' : 'var(--tn-accent)'};
  margin-top: 4px;
`

// "Locating your bus…" / "No live bus data — tracking by GPS": a neutral
// status chip, warn-tinted when the feed has nothing for this route.
export const LocatingIndicator = styled.div<{ $tone?: 'warn' }>`
  ${statusChip}
  animation: ${pulseOpacity} 1.5s ease-in-out infinite;
  background-color: ${(p) =>
    p.$tone === 'warn' ? 'var(--tn-warn-soft)' : 'var(--tn-surface-2)'};
  color: ${(p) => (p.$tone === 'warn' ? 'var(--tn-warn)' : 'var(--tn-text-2)')};
  margin-top: 4px;
`

// Mid-trip re-route quick chips + typed message
export const RerouteChips = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: var(--tn-space-2);
  margin: var(--tn-space-3) 0;
`

/** TnChip: 36px pill, 44px touch area; aria-pressed="true" reads selected. */
export const RerouteChip = styled(TnChip)`
  &[aria-pressed='true'] {
    background-color: var(--tn-accent-soft);
    color: var(--tn-accent);
    font-weight: 600;
  }
  &:active:not(:disabled) {
    filter: brightness(0.94);
  }
`

export const RerouteNlRow = styled.div`
  display: flex;
  gap: var(--tn-space-2);
`

export const RerouteNlInput = styled.input`
  background-color: var(--tn-surface-2);
  border: 0;
  border-radius: var(--tn-radius-sm);
  color: var(--tn-text);
  flex: 1;
  /* 16px: iOS zooms the page into any smaller input on focus. */
  font: 400 16px/22px var(--tn-font);
  min-height: var(--tn-control-h);
  min-width: 0;
  padding: 0 12px;

  &::placeholder {
    color: var(--tn-text-3);
  }
`

export const RerouteSendButton = styled.button`
  ${primaryPill}
  flex: none;
  min-width: 64px;
  padding: 0 var(--tn-space-4);
`

export const RerouteNlError = styled.div`
  color: var(--tn-danger);
  font: var(--tn-type-sm);
  margin-top: 6px;
`

// In-trip overview sheet: grabber tab + rest-of-trip list + alternatives.
// Reuses BoardingOverlay/BoardingSheet (above) so the live map keeps running
// underneath while the rider browses without leaving their route. The tab is
// the shared TnSheetGrabber, pinned to the bottom centre above the safe area.
export const SheetHandle = styled(TnSheetGrabber)`
  bottom: 0;
  left: 50%;
  padding-bottom: calc(var(--tn-space-3) + var(--tn-safe-bottom));
  position: absolute;
  transform: translateX(-50%);
  z-index: 1100;
`

export const SheetHandleLabel = styled.span`
  color: var(--tn-text);
  font: 600 14px/18px var(--tn-font);
  white-space: nowrap;
`

export const SheetHeader = styled.div`
  align-items: center;
  display: flex;
  gap: var(--tn-space-2);
  justify-content: space-between;
  margin-bottom: 4px;

  & > div {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--tn-space-1);
  }
`

// Map/list toggle for the trip sheet. Deliberately quiet next to the close
// button — it mirrors the results screen's ExpandMapButton, which is also a
// small secondary control rather than a primary action.
export const SheetExpandButton = styled.button`
  ${secondaryPill}
  font-size: 14px;
  min-height: var(--tn-tap);
  padding: 0 var(--tn-space-3);
`

export const SheetCloseButton = styled.button`
  align-items: center;
  appearance: none;
  background-color: var(--tn-surface-2);
  border: none;
  border-radius: var(--tn-radius-pill);
  color: var(--tn-text-2);
  cursor: pointer;
  display: inline-flex;
  flex: none;
  font-size: 24px;
  height: var(--tn-tap);
  justify-content: center;
  line-height: 1;
  padding: 0;
  width: var(--tn-tap);

  &:active {
    color: var(--tn-text);
    filter: brightness(0.94);
  }
`

export const SheetSectionTitle = styled.h4`
  color: var(--tn-text-2);
  font: var(--tn-type-xs);
  letter-spacing: var(--tn-tracking-xs);
  margin: 24px 0 8px;
  text-transform: uppercase;
`

// A leg line. $current is the "Right now" card: a surface-2 inset block whose
// 3px accent left border is how verify-trip-sheet-ui.js finds it.
export const LegRow = styled.div<{ $current?: boolean; $dim?: boolean }>`
  align-items: flex-start;
  border-left: 3px solid
    ${(p) => (p.$current ? 'var(--tn-accent)' : 'transparent')};
  color: var(--tn-text);
  display: flex;
  gap: 10px;
  opacity: ${(p) => (p.$dim ? 0.45 : 1)};
  padding: 8px 0 8px 10px;
  ${(p) =>
    p.$current &&
    css`
      background-color: var(--tn-surface-2);
      border-radius: 0 var(--tn-radius-sm) var(--tn-radius-sm) 0;
      padding: 12px 12px 12px 12px;
    `}
`

export const LegIcon = styled.div`
  font-size: 22px;
  line-height: 1.3;
`

export const LegInfo = styled.div`
  flex: 1;
  min-width: 0;
`

export const LegTitle = styled.div`
  color: var(--tn-text);
  font: 600 16px/22px var(--tn-font);
`

export const LegSubtitle = styled.div`
  color: var(--tn-text-2);
  font: var(--tn-type-sm);
`

export const WaitNote = styled.div`
  align-items: center;
  color: var(--tn-warn);
  display: flex;
  font: 600 13px/18px var(--tn-font);
  gap: 4px;
  margin-top: 3px;
`

export const StopList = styled.ul`
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
`

export const StopRow = styled.li<{ $next?: boolean; $passed?: boolean }>`
  align-items: center;
  color: ${(p) =>
    p.$passed
      ? 'var(--tn-text-3)'
      : p.$next
      ? 'var(--tn-accent)'
      : 'var(--tn-text-2)'};
  display: flex;
  font: ${(p) => (p.$next ? 600 : 400)} 14px/20px var(--tn-font);
  gap: 8px;
  padding: 3px 0;
`

export const StopDot = styled.span<{ $next?: boolean; $passed?: boolean }>`
  background: ${(p) =>
    p.$next
      ? 'var(--tn-accent)'
      : p.$passed
      ? 'var(--tn-border)'
      : 'var(--tn-text-3)'};
  border-radius: 50%;
  flex-shrink: 0;
  height: ${(p) => (p.$next ? 10 : 7)}px;
  width: ${(p) => (p.$next ? 10 : 7)}px;
`

// Auto mode (65.2, cycle 36 B2): the chip over the map's top-right corner —
// a surface pill with the map controls' shadow at a thumb-sized height, below
// the deviation banner's row; solid accent while Auto is on — and the preset
// sheet's rows, which are the vehicle list's rows as radio labels.
export const AutoChip = styled(RerouteChip)<{ $on: boolean }>`
  background-color: ${(p) =>
    p.$on ? 'var(--tn-accent)' : 'var(--tn-surface)'};
  box-shadow: var(--tn-shadow);
  color: ${(p) => (p.$on ? 'var(--tn-accent-ink)' : 'var(--tn-text)')};
  display: block;
  font-weight: 600;
  line-height: var(--tn-tap);
  max-width: calc(100% - 20px);
  min-height: var(--tn-tap);
  overflow: hidden;
  position: absolute;
  right: 10px;
  text-overflow: ellipsis;
  top: 52px;
  white-space: nowrap;
  z-index: 1001;

  &[aria-pressed='true'] {
    background-color: var(--tn-accent);
    color: var(--tn-accent-ink);
  }
  &::after {
    display: none;
  }
`

export const AutoPresetRow = styled(VehicleOptionRow)<{ $selected: boolean }>`
  background-color: ${(p) =>
    p.$selected ? 'var(--tn-accent-soft)' : 'var(--tn-surface-2)'};
  border-color: ${(p) => (p.$selected ? 'var(--tn-accent)' : 'transparent')};
  cursor: pointer;
  gap: 12px;
  justify-content: flex-start;
  min-height: var(--tn-tap);

  input {
    accent-color: var(--tn-accent);
    flex-shrink: 0;
    height: 20px;
    margin: 0;
    width: 20px;
  }
`
