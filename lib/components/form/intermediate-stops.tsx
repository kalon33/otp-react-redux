import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import React, { useState } from 'react'
import styled from 'styled-components'

import * as formActions from '../../actions/form'
import { isStopPlace, MAX_STOPS } from '../../util/multi-stop'

import AddPlaceButton from './add-place-button'
import IntermediatePlace from './intermediate-place-field'

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

interface Props {
  from: unknown
  intermediatePlaces: unknown[]
  setQueryParam: (params: Record<string, unknown>) => void
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
 */
function IntermediateStops({
  from,
  intermediatePlaces,
  setQueryParam,
  to
}: Props): JSX.Element | null {
  const intl = useIntl()
  const [adding, setAdding] = useState(false)
  const stops = (intermediatePlaces || []).filter(isStopPlace)

  const setStops = (next: unknown[]) =>
    setQueryParam({ intermediatePlaces: next })

  const placeholder = intl.formatMessage({
    id: 'components.MultiStop.stopPlaceholder'
  })

  const canAdd = !!from && !!to && !adding && stops.length < MAX_STOPS

  return (
    <>
      {stops.map((place, i) => (
        <IntermediatePlace
          index={i}
          inputPlaceholder={placeholder}
          key={i}
          location={place}
          locationType="to"
          onLocationCleared={({ index }: { index: number }) => {
            setStops(stops.filter((_, n) => n !== index))
          }}
          onLocationSelected={(result: { location: unknown }) => {
            const next = [...stops]
            next[i] = result.location as any
            setStops(next)
          }}
          showClearButton
        />
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
  const { from, intermediatePlaces, to } = state.otp.currentQuery
  return { from, intermediatePlaces, to }
}

const mapDispatchToProps = {
  setQueryParam: formActions.setQueryParam
}

export default connect(mapStateToProps, mapDispatchToProps)(IntermediateStops)
