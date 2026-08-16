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
`

export const ULContainer = styled.ul`
  list-style: none;
  padding: 0;
`

export const ModeResultContainer = styled.div`
  padding: 0 1em;
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
`

/**
 * Marks a result that doesn't ride the route the rider locked the search to.
 * OTP answers a locked search with the bike-the-whole-way option too; it stays
 * in the list, but never disguised as the trip that was asked for.
 */
export const OffRouteNote = styled.div`
  color: #666;
  font-size: 12px;
  font-style: italic;
  padding: 4px 1em 0;
`
