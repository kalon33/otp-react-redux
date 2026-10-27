import { ButtonGroup } from 'react-bootstrap'
import styled from 'styled-components'

export const FlexButtonGroup = styled(ButtonGroup)`
  display: flex;
  flex: 1;
  margin-top: 5px;
  button {
    flex: 1;
  }
`

export const NarrativeItinerariesContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;

  // Prevent the loading spinner from clipping the top of the container
  .loading-container {
    margin-top: 25px;
  }

  /* The phone's results list sits on the page ground, cards on top. */
  .otp.mobile && {
    background-color: var(--tn-bg);
    color: var(--tn-text);
  }
  .otp.mobile && .loading-container {
    color: var(--tn-text-3);
    margin: 16px 0 24px;
  }
`

export const ULContainer = styled.ul`
  list-style: none;
  padding: 0;

  /* One card per result, 10 px apart (mobile overhaul). */
  .otp.mobile && {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0 0 12px;
  }
`

export const ModeResultContainer = styled.div`
  padding: 0 1em;

  /* "Bike + Transit": an eyebrow over its cards, not a 24 px headline. */
  .otp.mobile && {
    padding: 0 var(--tn-space-3);
  }
  .otp.mobile && > h3 {
    color: var(--tn-text-2);
    font: var(--tn-type-xs);
    letter-spacing: var(--tn-tracking-xs);
    margin: var(--tn-space-4) var(--tn-space-1) var(--tn-space-2);
    text-transform: uppercase;
  }
`

export const SingleModeRowContainer = styled.ul`
  display: grid;
  gap: 10px;
  grid-template-columns: 1fr 1fr 1fr;
  list-style: none;
  padding: 0 0 15px 0;

  &:first-of-type {
    margin-top: 15px;
  }

  .otp.mobile && {
    gap: 8px;
    padding-bottom: calc(var(--tn-space-4) + var(--tn-safe-bottom));
  }
`

/**
 * Marks a result that doesn't ride the route the rider locked the search to.
 * OTP answers a locked search with the bike-the-whole-way option too; it stays
 * in the list, but never disguised as the trip that was asked for.
 */
export const OffRouteNote = styled.div`
  color: var(--tn-text-2);
  font-size: 12px;
  font-style: italic;
  padding: 4px 1em 0;
`
