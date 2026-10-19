import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import React, { useState } from 'react'
import styled from 'styled-components'

import * as formActions from '../../actions/form'
import {
  canonicalStopStays,
  clampStopStay,
  isStopPlace,
  MAX_STOP_STAY_MINUTES,
  MAX_STOPS,
  STOP_STAY_OPTIONS_MINUTES
} from '../../util/multi-stop'

import AddPlaceButton from './add-place-button'
import IntermediatePlace from './intermediate-place-field'
import StayChips, { useStayLabel } from './stay-chips'

/**
 * The call-taker's button is a desktop text link (16 px tall). On the phone it
 * is the only way to add a stop, so give it a thumb-sized row.
 */
const AddStopRow = styled.div`
  .add-place-button {
    margin: 0 !important;
    min-height: 44px;
    padding: 0 10px;
  }
`

/** The stay chips sit under their stop, clear of the next stop's field. */
const StayRow = styled.div`
  padding-bottom: 8px;
`

interface Props {
  from: unknown
  intermediatePlaces: unknown[]
  setQueryParam: (params: Record<string, unknown>) => void
  stopStays?: unknown[]
  to: unknown
}

/**
 * The rider's stops between origin and destination (backlog 43.1, the rider's
 * "multiple stops"). The fields and the "Add stop" button are the call-taker
 * panel's own (IntermediatePlace, AddPlaceButton), so they match the origin and
 * destination fields above and below them.
 *
 * Stops live on `currentQuery.intermediatePlaces`, which carries them into the
 * URL and, as `via` visits, into the plan request. A stop being typed is held
 * here, not on the query, so a half-filled field never reaches the URL.
 *
 * Each stop has its own stay (backlog 58.3, the rider's answer 10-18: "a
 * separate stay for each stop"): the round trip's chips, one row under each
 * stop, on `currentQuery.stopStays` in the same order as the stops. The stay
 * is a minimum, and taking a stop out takes its stay with it. Like a stop, a
 * stay is asked of OTP on the next Plan tap.
 */
function IntermediateStops({
  from,
  intermediatePlaces,
  setQueryParam,
  stopStays,
  to
}: Props): JSX.Element | null {
  const intl = useIntl()
  const stayLabel = useStayLabel()
  const [adding, setAdding] = useState(false)
  const stops = (intermediatePlaces || []).filter(isStopPlace)
  const stays = stops.map((_, i) =>
    clampStopStay(Array.isArray(stopStays) ? stopStays[i] : 0)
  )

  /** The stops and their stays always change together. */
  const setStops = (next: unknown[], nextStays: number[] = stays) =>
    setQueryParam({
      intermediatePlaces: next,
      stopStays: canonicalStopStays(nextStays.slice(0, next.length))
    })

  const setStay = (index: number, minutes: number) => {
    const next = [...stays]
    next[index] = minutes
    setQueryParam({ stopStays: canonicalStopStays(next) })
  }

  const chipLabel = (minutes: number) =>
    minutes === 0
      ? intl.formatMessage({ id: 'components.MultiStop.noStay' })
      : stayLabel(minutes)

  const placeholder = intl.formatMessage({
    id: 'components.MultiStop.stopPlaceholder'
  })

  const canAdd = !!from && !!to && !adding && stops.length < MAX_STOPS

  return (
    <>
      {stops.map((place, i) => (
        <React.Fragment key={i}>
          <IntermediatePlace
            index={i}
            inputPlaceholder={placeholder}
            location={place}
            locationType="to"
            onLocationCleared={({ index }: { index: number }) => {
              setStops(
                stops.filter((_, n) => n !== index),
                stays.filter((_, n) => n !== index)
              )
            }}
            onLocationSelected={(result: { location: unknown }) => {
              const next = [...stops]
              next[i] = result.location as any
              setStops(next)
            }}
            showClearButton
          />
          <StayRow className="multi-stop-stay">
            <StayChips
              groupLabel={intl.formatMessage(
                { id: 'components.MultiStop.stayGroupLabel' },
                { stop: (place as any).name || i + 1 }
              )}
              labelFor={chipLabel}
              max={MAX_STOP_STAY_MINUTES}
              min={1}
              onChange={(minutes: number) => setStay(i, minutes)}
              options={STOP_STAY_OPTIONS_MINUTES}
              value={stays[i]}
            />
          </StayRow>
        </React.Fragment>
      ))}
      {adding && (
        <IntermediatePlace
          index={stops.length}
          inputPlaceholder={placeholder}
          // `{}`, not null: IntermediatePlace clears only a field that has a
          // location, and clearing is how the rider takes back an unwanted
          // empty stop.
          location={{} as any}
          locationType="to"
          onLocationCleared={() => setAdding(false)}
          onLocationSelected={(result: { location: unknown }) => {
            setAdding(false)
            if (isStopPlace(result?.location)) {
              setStops([...stops, result.location])
            }
          }}
          showClearButton
        />
      )}
      {canAdd && (
        <AddStopRow>
          <AddPlaceButton
            from={from}
            intermediatePlaces={stops}
            label={<FormattedMessage id="components.MultiStop.addStop" />}
            onClick={() => setAdding(true)}
            to={to}
          />
        </AddStopRow>
      )}
    </>
  )
}

const mapStateToProps = (state: any) => {
  const { from, intermediatePlaces, stopStays, to } = state.otp.currentQuery
  return { from, intermediatePlaces, stopStays, to }
}

const mapDispatchToProps = {
  setQueryParam: formActions.setQueryParam
}

export default connect(mapStateToProps, mapDispatchToProps)(IntermediateStops)
