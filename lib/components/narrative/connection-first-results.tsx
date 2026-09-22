import { humanizeDistanceString } from '@opentripplanner/humanize-distance'
import { Leg } from '@opentripplanner/types'
import { useIntl } from 'react-intl'
import React, {
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import styled from 'styled-components'

import {
  BoardingChoice,
  Connection,
  connectionStartTimes
} from '../../util/connection-first'
import { ComponentContext } from '../../util/contexts'
import { ItineraryWithIndex } from '../../util/itinerary'

import DefaultRouteRenderer from './metro/default-route-renderer'

/**
 * The results list, connection first (backlog 21.5, behind the Settings flag).
 *
 *   1  Where do you get on?   one card per boarding stop
 *   2  Where do you get off?  one card per get-off stop from the chosen one
 *   3  the chosen connection  its departures, next available pre-selected
 *
 * Screens 1 and 2 carry NO time of any kind — no duration, no departure, no
 * arrival, no "more times". The rider, 2026-09-22 16:09: "get rid of the times
 * temporarily till you figure this out". Distances only, and the order of each
 * list (soonest arrival first) is the only trace of a clock.
 *
 * Screen 3 is the app's own itinerary card (the context ItineraryBody, i.e.
 * MetroItinerary) opened on the next available departure, with this
 * connection's departures as its 23.1 chips and the existing Start button, so
 * nothing about starting a trip is re-implemented here.
 *
 * Colours and sizes are the ones the mock (revision 2) lifted from the app:
 * DARK_TEXT_GREY rules, the variants toggle's #eef1f6 / #c9d0dc, the green of
 * the Start button family for get-off stops.
 */

const Steps = styled.ol`
  border-bottom: 1px solid #33333333;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  list-style: none;
  margin: 0;
  padding: 8px 16px;

  li {
    align-items: center;
    color: #0909098f;
    display: flex;
    font-size: 11.5px;
    gap: 6px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  li i {
    align-items: center;
    border: 1.5px solid currentColor;
    border-radius: 50%;
    display: inline-flex;
    flex: none;
    font-size: 11px;
    font-style: normal;
    font-weight: 700;
    height: 18px;
    justify-content: center;
    width: 18px;
  }
  li.now {
    color: #2196f3;
    font-weight: 700;
  }
  li.done {
    color: #2e7d32;
  }
  li.done i {
    background: #2e7d32;
    border-color: #2e7d32;
    color: #fff;
  }
`

const ListHead = styled.h3`
  color: #333;
  font-size: 17px;
  font-weight: 700;
  margin: 0;
  padding: 14px 16px 2px;
`

const ListSub = styled.div`
  color: #666;
  font-size: 13px;
  padding: 0 16px 6px;
`

const Cards = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0 0 18px;
`

const Card = styled.button`
  background: #fff;
  border: 0;
  border-bottom: 0.1ch solid #33333333;
  color: #333;
  cursor: pointer;
  display: flex;
  font: inherit;
  gap: 12px;
  padding: 13px 16px 12px;
  text-align: left;
  width: 100%;

  &:hover {
    background: #fafcff;
  }
  &:focus-visible {
    outline: 3px solid #2196f3;
    outline-offset: -3px;
  }
`

const CardMain = styled.span`
  display: block;
  flex: 1;
  min-width: 0;
`

const Chevron = styled.span`
  color: #0909098f;
  flex: none;
  font-size: 18px;
  line-height: 1.2;
`

const StopName = styled.span`
  color: #000000cc;
  display: block;
  font-size: 16.5px;
  font-weight: 700;
  line-height: 1.3;

  &.off {
    color: #2e7d32;
  }
`

const StopSub = styled.span`
  color: #666;
  display: block;
  font-size: 13px;
  margin-top: 2px;
`

const Routes = styled.span`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;

  .joiner {
    color: #0909098f;
    font-size: 13px;
  }
`

const Count = styled.span`
  color: #666;
  display: block;
  font-size: 12.5px;
  margin-top: 8px;
`

const SoFar = styled.div`
  background: #eef1f6;
  border-bottom: 1px solid #33333333;
  padding: 10px 16px;
`

const SoFarLine = styled.div`
  align-items: baseline;
  display: flex;
  font-size: 13.5px;
  gap: 8px;
  line-height: 1.4;

  .k {
    color: #0909098f;
    flex: none;
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    width: 46px;
  }
  .v {
    color: #333;
    flex: 1;
    font-weight: 600;
    min-width: 0;
  }
  .v.off {
    color: #2e7d32;
  }
  button {
    background: none;
    border: 0;
    color: #2196f3;
    cursor: pointer;
    flex: none;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    min-height: 32px;
    padding: 0 4px;
  }
`

export type RenderConnectionItinerary = (
  itinerary: ItineraryWithIndex,
  onChoose: (payload: { index: number }) => void
) => ReactNode

type Props = {
  choices: BoardingChoice[]
  /** Highlight a departure on the map (setVisibleItinerary). */
  onShow?: (index: number | null) => void
  renderItinerary: RenderConnectionItinerary
}

type Step = 1 | 2 | 3

function RoutePill({ leg }: { leg: Leg }): JSX.Element {
  const { RouteRenderer } = useContext(ComponentContext) as {
    RouteRenderer?: React.ComponentType<{ leg: Leg }>
  }
  const Route = RouteRenderer || DefaultRouteRenderer
  return <Route leg={leg} />
}

const ConnectionFirstResults = ({
  choices,
  onShow,
  renderItinerary
}: Props): JSX.Element => {
  const intl = useIntl()
  const [boardKey, setBoardKey] = useState<string | null>(null)
  const [connectionKey, setConnectionKey] = useState<string | null>(null)
  const [chosenIndex, setChosenIndex] = useState<number | null>(null)

  const distance = useCallback(
    (meters: number) => humanizeDistanceString(meters, false, intl),
    [intl]
  )

  const choice = useMemo(
    () => choices.find((c) => c.key === boardKey) || null,
    [boardKey, choices]
  )
  const connection: Connection | null = useMemo(
    () => choice?.connections.find((c) => c.key === connectionKey) || null,
    [choice, connectionKey]
  )
  // A new batch of responses can drop what was chosen; fall back a screen.
  const step: Step = connection ? 3 : choice ? 2 : 1

  const chosen: ItineraryWithIndex | null = useMemo(() => {
    if (!connection) return null
    return (
      connection.departures.find((itin) => itin.index === chosenIndex) ||
      connection.next
    )
  }, [chosenIndex, connection])

  // Keyed on the index, not the object: a new batch of responses rebuilds
  // every connection, and the map only needs telling when the trip changes.
  const shownIndex = chosen ? chosen.index : null
  const everShown = useRef(false)
  useEffect(() => {
    // Screen 1 on arrival leaves the map as the list left it.
    if (shownIndex === null && !everShown.current) return
    everShown.current = true
    onShow?.(shownIndex)
  }, [shownIndex, onShow])

  const pickConnection = useCallback((c: Connection) => {
    setConnectionKey(c.key)
    // "Just assume the next available time" (09-22 12:00).
    setChosenIndex(c.next.index)
  }, [])

  const pickChoice = useCallback(
    (c: BoardingChoice) => {
      setBoardKey(c.key)
      setConnectionKey(null)
      setChosenIndex(null)
      // One place to get off (or no bus at all): nothing to choose on screen 2.
      if (c.connections.length === 1) pickConnection(c.connections[0])
    },
    [pickConnection]
  )

  const backToBoard = useCallback(() => {
    setBoardKey(null)
    setConnectionKey(null)
    setChosenIndex(null)
  }, [])

  const backToOff = useCallback(() => {
    if (!choice || choice.connections.length < 2) {
      backToBoard()
      return
    }
    setConnectionKey(null)
    setChosenIndex(null)
  }, [backToBoard, choice])

  const onChooseDeparture = useCallback(
    (payload: { index: number }) => setChosenIndex(payload.index),
    []
  )

  const choiceName = (c: BoardingChoice): string => {
    if (!c.direct) return c.stop?.name || ''
    if (c.accessMode === 'BICYCLE') {
      return intl.formatMessage({
        defaultMessage: 'Bike the whole way',
        id: 'components.ConnectionFirst.bikeWholeWay'
      })
    }
    if (c.accessMode === 'WALK') {
      return intl.formatMessage({
        defaultMessage: 'Walk the whole way',
        id: 'components.ConnectionFirst.walkWholeWay'
      })
    }
    return intl.formatMessage({
      defaultMessage: 'No transit',
      id: 'components.ConnectionFirst.noTransit'
    })
  }

  const accessText = (c: BoardingChoice): string => {
    const values = { distance: distance(c.accessMeters) }
    if (c.direct) {
      return intl.formatMessage(
        {
          defaultMessage: '{distance}, no bus',
          id: 'components.ConnectionFirst.directDistance'
        },
        values
      )
    }
    return c.accessMode === 'BICYCLE'
      ? intl.formatMessage(
          {
            defaultMessage: 'Bike {distance} to get here',
            id: 'components.ConnectionFirst.accessBike'
          },
          values
        )
      : intl.formatMessage(
          {
            defaultMessage: 'Walk {distance} to get here',
            id: 'components.ConnectionFirst.accessWalk'
          },
          values
        )
  }

  const egressText = (c: Connection): string => {
    if (c.egressMeters < 1) {
      return intl.formatMessage({
        defaultMessage: 'Your destination is right here',
        id: 'components.ConnectionFirst.egressNone'
      })
    }
    const values = { distance: distance(c.egressMeters) }
    return c.egressMode === 'BICYCLE'
      ? intl.formatMessage(
          {
            defaultMessage: 'Then bike {distance} to your destination',
            id: 'components.ConnectionFirst.egressBike'
          },
          values
        )
      : intl.formatMessage(
          {
            defaultMessage: 'Then walk {distance} to your destination',
            id: 'components.ConnectionFirst.egressWalk'
          },
          values
        )
  }

  const placesToGetOff = (count: number): string =>
    intl.formatMessage(
      {
        defaultMessage:
          '{count, plural, one {# place to get off} other {# places to get off}}',
        id: 'components.ConnectionFirst.placesToGetOff'
      },
      { count }
    )

  const orWord = intl.formatMessage({
    defaultMessage: 'or',
    id: 'components.ConnectionFirst.or'
  })
  const thenWord = intl.formatMessage({
    defaultMessage: 'then',
    id: 'components.ConnectionFirst.then'
  })
  const onAtWord = intl.formatMessage({
    defaultMessage: 'On at',
    id: 'components.ConnectionFirst.onAt'
  })
  const offAtWord = intl.formatMessage({
    defaultMessage: 'Off at',
    id: 'components.ConnectionFirst.offAt'
  })
  const changeWord = intl.formatMessage({
    defaultMessage: 'Change',
    id: 'components.ConnectionFirst.change'
  })

  const joiner = (word: string, key: string) => (
    <span aria-hidden className="joiner" key={key}>
      {word}
    </span>
  )

  const renderChains = (c: Connection) =>
    c.chains.map((chain, ci) => (
      <React.Fragment key={ci}>
        {ci > 0 && joiner(orWord, `or-${ci}`)}
        {chain.map((leg, li) => (
          <React.Fragment key={li}>
            {li > 0 && joiner(thenWord, `then-${ci}-${li}`)}
            <RoutePill leg={leg} />
          </React.Fragment>
        ))}
      </React.Fragment>
    ))

  const stepClass = (n: Step) =>
    n === step ? 'now' : n < step ? 'done' : undefined

  return (
    <div className="connection-first" data-step={step}>
      <Steps aria-hidden>
        <li className={stepClass(1)}>
          <i>1</i>
          {intl.formatMessage({
            defaultMessage: 'Get on',
            id: 'components.ConnectionFirst.stepGetOn'
          })}
        </li>
        <li className={stepClass(2)}>
          <i>2</i>
          {intl.formatMessage({
            defaultMessage: 'Get off',
            id: 'components.ConnectionFirst.stepGetOff'
          })}
        </li>
        <li className={stepClass(3)}>
          <i>3</i>
          {intl.formatMessage({
            defaultMessage: 'Times',
            id: 'components.ConnectionFirst.stepTimes'
          })}
        </li>
      </Steps>

      {step === 1 && (
        <div className="connection-first-board">
          <ListHead>
            {intl.formatMessage({
              defaultMessage: 'Where do you get on?',
              id: 'components.ConnectionFirst.getOnHeading'
            })}
          </ListHead>
          <ListSub>
            {intl.formatMessage(
              {
                defaultMessage:
                  '{count, plural, one {# way to start} other {# ways to start}}',
                id: 'components.ConnectionFirst.waysToStart'
              },
              { count: choices.length }
            )}
          </ListSub>
          <Cards>
            {choices.map((c) => (
              <li key={c.key}>
                <Card
                  className="connection-card board-card"
                  data-key={c.key}
                  onClick={() => pickChoice(c)}
                  type="button"
                >
                  <CardMain>
                    <StopName>{choiceName(c)}</StopName>
                    <StopSub>{accessText(c)}</StopSub>
                    {!c.direct && (
                      <>
                        <Routes>
                          {c.routes.map((leg, i) => (
                            <React.Fragment key={i}>
                              {i > 0 && joiner(orWord, `or-${i}`)}
                              <RoutePill leg={leg} />
                            </React.Fragment>
                          ))}
                        </Routes>
                        <Count>{placesToGetOff(c.connections.length)}</Count>
                      </>
                    )}
                  </CardMain>
                  <Chevron aria-hidden>›</Chevron>
                </Card>
              </li>
            ))}
          </Cards>
        </div>
      )}

      {step === 2 && choice && (
        <div className="connection-first-off">
          <SoFar>
            <SoFarLine>
              <span className="k">{onAtWord}</span>
              <span className="v">{choiceName(choice)}</span>
              <button onClick={backToBoard} type="button">
                {changeWord}
              </button>
            </SoFarLine>
          </SoFar>
          <ListHead>
            {intl.formatMessage({
              defaultMessage: 'Where do you get off?',
              id: 'components.ConnectionFirst.getOffHeading'
            })}
          </ListHead>
          <ListSub>{placesToGetOff(choice.connections.length)}</ListSub>
          <Cards>
            {choice.connections.map((c) => (
              <li key={c.key}>
                <Card
                  className="connection-card off-card"
                  data-key={c.key}
                  onClick={() => pickConnection(c)}
                  type="button"
                >
                  <CardMain>
                    <StopName className="off">{c.alight?.name}</StopName>
                    <StopSub>{egressText(c)}</StopSub>
                    <Routes>{renderChains(c)}</Routes>
                  </CardMain>
                  <Chevron aria-hidden>›</Chevron>
                </Card>
              </li>
            ))}
          </Cards>
        </div>
      )}

      {step === 3 && choice && connection && chosen && (
        <div className="connection-first-times">
          <SoFar>
            <SoFarLine>
              <span className="k">{onAtWord}</span>
              <span className="v">{choiceName(choice)}</span>
              <button onClick={backToBoard} type="button">
                {changeWord}
              </button>
            </SoFarLine>
            {!connection.direct && (
              <SoFarLine>
                <span className="k">{offAtWord}</span>
                <span className="v off">{connection.alight?.name}</span>
                <button onClick={backToOff} type="button">
                  {changeWord}
                </button>
              </SoFarLine>
            )}
          </SoFar>
          {renderItinerary(
            connection.departures.length > 1
              ? ({
                  ...chosen,
                  // The 23.1 chips, holding this connection's buses only.
                  allStartTimes: connectionStartTimes(connection)
                } as ItineraryWithIndex)
              : chosen,
            onChooseDeparture
          )}
        </div>
      )}
    </div>
  )
}

export default ConnectionFirstResults
