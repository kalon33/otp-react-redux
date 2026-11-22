/**
 * What a Calm / Wander ride is, on its result card (backlog 76.2): a thin
 * strip of how stressful the streets are along it, how much of it is calm,
 * what it passes, the stop's shelter / bench / light when OpenStreetMap maps
 * the stop, and when the DIRECT ride would leave — the card's own "You leave"
 * is this ride's, so the rider sees both leave-by times (decision 2: the
 * spare time comes from leaving earlier for the same bus).
 *
 * Renders nothing for an itinerary without an explore ride, so a Direct card
 * is exactly the old card.
 */
import { FormattedMessage, injectIntl, IntlShape } from 'react-intl'
import React from 'react'
import styled from 'styled-components'
import type { Itinerary } from '@opentripplanner/types'

import {
  exploreDirectLeaveMs,
  exploreRideOf,
  StressCategory,
  stressShares,
  stressStripSegments
} from '../../../util/bike-explore'
import FormattedDuration from '../../util/formatted-duration'

const Details = styled.div`
  color: var(--tn-text-2);
  display: flex;
  flex-direction: column;
  font: var(--tn-type-sm);
  font-variant-numeric: var(--tn-tabular);
  gap: 6px;
  min-width: 0;

  .explore-line {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .explore-calm {
    color: var(--tn-live);
    font-weight: 600;
  }
  .explore-nicest {
    background-color: var(--tn-live-soft);
    border-radius: var(--tn-radius-pill);
    color: var(--tn-live);
    display: inline-block;
    font: var(--tn-type-xs);
    letter-spacing: var(--tn-tracking-xs);
    margin-right: 6px;
    padding: 1px 8px;
    text-transform: uppercase;
    vertical-align: 1px;
  }
`

/**
 * Four categories, told apart by more than hue: calm is solid, busier is
 * solid amber, heavy traffic solid red, and walking the bike is hatched.
 */
const Strip = styled.div`
  border-radius: var(--tn-radius-pill);
  display: flex;
  height: 6px;
  overflow: hidden;
  width: 100%;

  span {
    display: block;
    height: 100%;
    min-width: 2px;
  }
  .stress-calm {
    background-color: var(--tn-live);
  }
  .stress-busy {
    background-color: var(--tn-warn);
  }
  .stress-heavy {
    background-color: var(--tn-danger);
  }
  .stress-walk {
    background: repeating-linear-gradient(
      135deg,
      var(--tn-text-3) 0 2px,
      transparent 2px 4px
    );
  }
`

const pct = (share: number) => Math.round(share * 100)

interface Props {
  intl: IntlShape
  itinerary: Itinerary
  /** The "Nicest ride" marker (rider's decision 3). */
  nicest?: boolean
}

export const ExploreRideDetails = ({
  intl,
  itinerary,
  nicest
}: Props): JSX.Element | null => {
  const ride = exploreRideOf(itinerary)
  if (!ride) return null
  const segments = stressStripSegments(ride.stressProfile)
  const shares = stressShares(segments)
  const place = ride.via || ride.places?.[0] || null
  const directLeave = exploreDirectLeaveMs(itinerary)
  const directS = ride.directDurationS
  // A bike-only ride's "stop" is the destination: no wait there to describe.
  const boards = (itinerary.legs || []).some((leg) => leg.transitLeg)
  const stop = boards ? ride.stop : null
  const amenities = stop?.mapped
    ? [
        stop.shelter &&
          intl.formatMessage({
            defaultMessage: 'shelter',
            id: 'components.BikeExplore.shelter'
          }),
        stop.bench &&
          intl.formatMessage({
            defaultMessage: 'bench',
            id: 'components.BikeExplore.bench'
          }),
        stop.lit &&
          intl.formatMessage({
            defaultMessage: 'lit',
            id: 'components.BikeExplore.lit'
          })
      ].filter(Boolean)
    : []
  const duration =
    directS != null && Number.isFinite(directS) ? (
      <FormattedDuration
        duration={Math.max(60, directS)}
        includeSeconds={false}
      />
    ) : null

  return (
    <Details className="explore-ride">
      <div className="explore-line">
        {nicest && (
          <span className="explore-nicest">
            {intl.formatMessage({
              defaultMessage: 'Nicest ride',
              id: 'components.BikeExplore.nicest'
            })}
          </span>
        )}
        <span className="explore-calm">
          {intl.formatMessage(
            {
              defaultMessage: '{percent}% calm',
              id: 'components.BikeExplore.calmShare'
            },
            { percent: pct(ride.calm) }
          )}
        </span>
        {ride.via ? (
          <>
            {' · '}
            {intl.formatMessage(
              {
                defaultMessage: 'via {place}',
                id: 'components.BikeExplore.via'
              },
              { place: ride.via }
            )}
          </>
        ) : place ? (
          <>
            {' · '}
            {intl.formatMessage(
              {
                defaultMessage: 'past {place}',
                id: 'components.BikeExplore.past'
              },
              { place }
            )}
          </>
        ) : null}
      </div>
      {segments.length > 0 && (
        <Strip
          aria-label={intl.formatMessage(
            {
              defaultMessage:
                'Street stress along the ride: {calm}% calm streets, {busy}% busier streets, {heavy}% heavy traffic, {walk}% walking the bike',
              id: 'components.BikeExplore.strip'
            },
            {
              busy: pct(shares.busy),
              calm: pct(shares.calm),
              heavy: pct(shares.heavy),
              walk: pct(shares.walk)
            }
          )}
          className="explore-strip"
          role="img"
        >
          {segments.map((segment, i) => (
            <span
              className={`stress-${segment.category as StressCategory}`}
              key={i}
              style={{ flexGrow: segment.metres }}
            />
          ))}
        </Strip>
      )}
      {(duration || amenities.length > 0) && (
        <div className="explore-line">
          {duration &&
            (directLeave !== null ? (
              <FormattedMessage
                defaultMessage="direct: leave {time} · {duration}"
                id="components.BikeExplore.directLeave"
                values={{ duration, time: intl.formatTime(directLeave) }}
              />
            ) : (
              <FormattedMessage
                defaultMessage="direct: {duration}"
                id="components.BikeExplore.directOnly"
                values={{ duration }}
              />
            ))}
          {duration && amenities.length > 0 && ' · '}
          {amenities.length > 0 &&
            intl.formatMessage(
              {
                defaultMessage: 'stop: {amenities}',
                id: 'components.BikeExplore.stopHas'
              },
              { amenities: amenities.join(', ') }
            )}
        </div>
      )}
    </Details>
  )
}

export default injectIntl(ExploreRideDetails)
