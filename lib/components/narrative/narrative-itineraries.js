/* eslint-disable react/prop-types */
import { connect } from 'react-redux'
import { differenceInDays } from 'date-fns'
import { FormattedMessage, injectIntl } from 'react-intl'
import { isFlex, isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import clone from 'clone'
import coreUtils from '@opentripplanner/core-utils'
import memoize from 'lodash.memoize'
import PropTypes from 'prop-types'
import React, { Component } from 'react'
import Skeleton, { SkeletonTheme } from 'react-loading-skeleton'

import * as uiActions from '../../actions/ui'
import {
  applyRouteLockToItineraries,
  itineraryMatchesLock,
  routeLockText
} from '../../util/route-lock'
import { ComponentContext } from '../../util/contexts'
import {
  demoteTokenTransitHops,
  findItineraryIndexByKey,
  getFirstLegStartTime,
  itinerariesAreEqual,
  legLocationsAreEqual,
  sortStartTimes
} from '../../util/itinerary'
import { firstTransitLegIsRealtime } from '../../util/viewer'
import {
  getActiveItineraries,
  getActiveSearch,
  getActiveSearchErrors,
  getRealtimeEffects,
  getVisibleItineraryIndex,
  sortItinerariesInPlaceIfNeeded
} from '../../util/state'
import { getItineraryView, isDefined, ItineraryView } from '../../util/ui'
import { grey } from '../util/colors'
import {
  logItineraryVariantRows,
  setActiveItinerary,
  setActiveLeg,
  setActiveStep,
  setVisibleItinerary,
  updateItineraryFilter
} from '../../actions/narrative'
import { summarizeQuery } from '../form/user-settings-i18n'
import InvisibleA11yLabel from '../util/invisible-a11y-label'
import PageTitle from '../util/page-title'

import * as S from './styled'
import { getFirstTransitLegStop } from './metro/attribute-utils'
import { getItineraryDescription } from './default/itinerary-description'
import ErrorRenderer from './metro/metro-error-renderer'
import Loading from './loading'
import NarrativeItinerariesHeader from './narrative-itineraries-header'

/** Creates a start time object for the given itinerary. */
function makeStartTime(itinerary) {
  return {
    itinerary,
    legs: itinerary.legs,
    realtime: firstTransitLegIsRealtime(itinerary)
  }
}

/**
 * Whether two itineraries board and alight every transit leg at the same
 * stops. The route-signature merge folds runs of the same routes together even
 * when they put the rider on or off a stop apart (98th St vs 66th St on the
 * Orange Line), and each departure it collects becomes a "You leave ..." time
 * link that makes its run active. A time link must change the time only, so a
 * run that boards or alights elsewhere is kept off the links and is offered
 * in the row's "Other stops" list instead (backlog 28.4, 21.5).
 */
function sameTransitStops(itinerary, other) {
  const legs = (itinerary.legs || []).filter((leg) => leg.transitLeg)
  const otherLegs = (other.legs || []).filter((leg) => leg.transitLeg)
  return (
    legs.length === otherLegs.length &&
    legs.every(
      (leg, i) =>
        legLocationsAreEqual(leg.from, otherLegs[i].from) &&
        legLocationsAreEqual(leg.to, otherLegs[i].to)
    )
  )
}

export const doMergeItineraries = memoize(
  (itineraries, defaultFareType, mergeByRouteSignature = false) => {
    const mergedItineraries = itineraries
      .reduce((prev, cur) => {
        const updatedItineraries = clone(prev)
        const updatedItinerary = clone(cur)

        const duplicateIndex = updatedItineraries.findIndex((itin) =>
          itinerariesAreEqual(itin, cur, defaultFareType, mergeByRouteSignature)
        )
        // If no duplicate, push full itinerary to output
        if (duplicateIndex === -1 || cur.legs.some(isFlex)) {
          updatedItineraries.push(updatedItinerary)
        } else if (
          // Only process itineraries less than 24 hours in the future
          differenceInDays(updatedItinerary.startTime, Date.now()) < 1
        ) {
          const duplicateFoundItin = updatedItineraries[duplicateIndex]
          // TODO: MERGE ROUTE NAMES

          // Add only new start time to existing itinerary.
          // The existing itinerary is the earliest between
          // this itinerary (updatedItinerary) and duplicateItin.
          // This is because alternate routes are only added to the first non-duplicate itinerary,
          // and we show alternate routes for the first (i.e. earliest) non-duplicate itinerary found.
          let duplicateItin = duplicateFoundItin
          let itinCopyToAdd = updatedItinerary
          if (duplicateFoundItin.startTime > updatedItinerary.startTime) {
            duplicateItin = updatedItinerary
            // The row changed hands; the group it had collected comes along,
            // with the new representative at its head.
            duplicateItin.sameShapeVariants = [
              updatedItinerary,
              ...(
                duplicateFoundItin.sameShapeVariants || [duplicateFoundItin]
              ).filter((variant) => variant.index !== updatedItinerary.index)
            ]
            // ...and so do its departure times, re-chosen against the NEW
            // representative's stops: the old list was filtered against the
            // old representative, which may have alighted elsewhere (28.4).
            // The old representative itself is itinCopyToAdd, added below.
            duplicateItin.allStartTimes = []
            duplicateItin.sameShapeVariants.forEach((variant) => {
              if (
                variant !== duplicateFoundItin &&
                sameTransitStops(duplicateItin, variant) &&
                !duplicateItin.allStartTimes.find(
                  (time) =>
                    getFirstLegStartTime(time.legs) === variant.startTime
                )
              ) {
                duplicateItin.allStartTimes.push(makeStartTime(variant))
              }
            })
            updatedItineraries[duplicateIndex] = updatedItinerary
            itinCopyToAdd = duplicateFoundItin
          }

          if (!duplicateItin.allStartTimes) {
            duplicateItin.allStartTimes = [makeStartTime(duplicateItin)]
          }
          // Every itinerary that folded into this row, representative first.
          // allStartTimes above keeps at most one entry per departure minute,
          // which is right for a list of times but loses same-shape variants
          // that leave together and differ only in where they put the rider
          // down (a 4.2 vs 6.3 mile closing bike). Those are exactly what the
          // drill-down exists to show, so they are kept here unfiltered.
          if (!duplicateItin.sameShapeVariants) {
            duplicateItin.sameShapeVariants = [duplicateItin]
          }
          if (
            !duplicateItin.sameShapeVariants.some(
              (variant) => variant.index === itinCopyToAdd.index
            )
          ) {
            duplicateItin.sameShapeVariants.push(itinCopyToAdd)
          }
          // Only add new time if it doesn't already exist. It would be better to use
          // the uniqueness feature of Set, but unfortunately objects are never equal.
          // A run that boards or alights at another stop is not another time
          // for this row: it stays in sameShapeVariants only (backlog 28.4).
          // This compares against duplicateItin, which is the NEW
          // representative when the row changed hands above.
          if (
            sameTransitStops(duplicateItin, itinCopyToAdd) &&
            !duplicateItin.allStartTimes.find(
              (time) =>
                getFirstLegStartTime(time.legs) === itinCopyToAdd.startTime
            )
          ) {
            duplicateItin.allStartTimes.push(makeStartTime(itinCopyToAdd))
          }

          // Some legs will be the same, but have a different route
          // This map catches those and stores the alternate routes so they can be displayed
          duplicateItin.legs = duplicateItin.legs.map((leg, index) => {
            const newLeg = clone(leg)
            const curLeg = itinCopyToAdd.legs[index]
            const curLegRouteId = curLeg?.routeId
            if (
              curLegRouteId &&
              leg?.routeId &&
              leg?.routeId !== curLegRouteId &&
              // Shape-based merging (mergeByRouteSignature) no longer requires
              // the two leg arrays to line up index-for-index, so a differing
              // number of access legs can put a bus opposite a train here.
              // Only a same-mode pair is a real alternate route.
              curLeg?.mode === leg?.mode
            ) {
              if (!newLeg.alternateRoutes) {
                newLeg.alternateRoutes = {}
              }
              newLeg.alternateRoutes[curLegRouteId] = {
                // We save the entire leg to the alternateRoutes object so in
                // the future, we can draw the leg on the map as an alternate route
                ...curLeg
              }
            }
            return newLeg
          })
        }
        return updatedItineraries
      }, [])
      .map((itin) => {
        // Sort allStartTimes if defined,
        // and display the earliest itinerary in each group.
        if (itin.allStartTimes?.length) {
          const sortedTimes = sortStartTimes(itin.allStartTimes)
          const firstItinerary = sortedTimes[0].itinerary
          firstItinerary.allStartTimes = sortedTimes
          return firstItinerary
        } else {
          return itin
        }
      })

    // Add allStartTime info from mergedItineraries to the original itineraries.
    //
    // Every itinerary that folded into a row gets the row's variants (so the
    // "Other stops" control is still there once the rider has switched the
    // card to another pair) and, as its own "You leave" links, the departures
    // of ITS get-on / get-off pair — not the representative's. Before this a
    // run reached from "Other stops" had no allStartTimes at all and the card
    // showed a single time (found on the 2026-09-23 build of backlog 21.5).
    const allItineraries = itineraries.map((itin, index) => {
      const row = mergedItineraries.find(
        (itn) =>
          itn.sameShapeVariants?.some((variant) => variant.index === index) ||
          itn.allStartTimes?.some((st) => st.itinerary.index === index)
      )
      if (!row) return { ...itin, index }
      const self =
        row.sameShapeVariants?.find((variant) => variant.index === index) ||
        (row.index === index ? row : null)
      let allStartTimes = row.allStartTimes
      if (self && row.sameShapeVariants?.length) {
        const times = []
        row.sameShapeVariants.forEach((variant) => {
          if (
            sameTransitStops(self, variant) &&
            !times.find(
              (time) => getFirstLegStartTime(time.legs) === variant.startTime
            )
          ) {
            times.push(makeStartTime(variant))
          }
        })
        if (times.length) allStartTimes = sortStartTimes(times)
      }
      return {
        ...itin,
        allStartTimes,
        index,
        sameShapeVariants: row.sameShapeVariants
      }
    })

    return {
      allItineraries,
      mergedItineraries
    }
  }
)

/**
 * Count, for the debug stream, what the rows on screen are actually offering:
 * how many result rows there are, how many of them carry a variants control,
 * how many itineraries folded into each, and how many rows offer a CHOICE OF
 * BOARDING STOP — the thing the rider was hunting for on 2026-09-15 (16.6).
 *
 * Integers only, and no stop names: this goes out on every search of every
 * ride, the payload must stay far under the log's size cap, and a stop name is
 * the rider's location.
 */
export function summariseVariantRows(mergedItineraries) {
  const rows = mergedItineraries || []
  const variantCounts = rows.map((itin) => itin?.sameShapeVariants?.length || 0)
  let rowsWithStopChoice = 0
  rows.forEach((itin) => {
    const variants = itin?.sameShapeVariants
    if (!variants || variants.length < 2) return
    const stops = new Set(
      variants.map((variant) => getFirstTransitLegStop(variant)).filter(Boolean)
    )
    if (stops.size > 1) rowsWithStopChoice++
  })
  return {
    rows: rows.length,
    rowsWithStopChoice,
    rowsWithVariants: variantCounts.filter((count) => count > 1).length,
    variantCounts
  }
}

/**
 * Which itinerary the URL is asking this list to select, or null to leave the
 * selection alone. -1 means clear it.
 *
 * `ui_activeItinerary` is a POSITION, and every re-plan renumbers the list
 * under it. On 2026-09-21 the rider chose index 38 (the 10:12 Orange Line,
 * trip 1:1348464) at 09:02; the 09:12:07 re-plan made index 38 the 10:19 one
 * (trip 1:1348091), and this restore then re-selected that trip four times —
 * 09:12:36.764, 09:20:55.661, 09:22:27.887, 09:23:46.089 — each time a trip
 * the rider had never picked (backlog 23.5). So `ui_activeItineraryKey` names
 * the trips themselves (actions/narrative.js) and the position is only a
 * fallback for a URL written before the key existed.
 *
 * A key that matches nothing is NOT immediately a wrong position to discard:
 * a search's responses arrive one mode combination at a time, so while the
 * search is still pending the answer is "not back yet" and the selection is
 * left where it is. Once the search has settled and the trip is still absent,
 * clearing beats pointing at a stranger's bus.
 */
export function resolveUrlItineraryIndex({
  itineraries,
  key,
  pending,
  urlIndex
}) {
  if (!key) return Number.isNaN(urlIndex) ? null : urlIndex
  const found = findItineraryIndexByKey(itineraries, key, urlIndex)
  if (found !== -1) return found
  if (pending || !itineraries?.length) return null
  return -1
}

// FIXME: move to typescript once shared types exist
class NarrativeItineraries extends Component {
  static propTypes = {
    activeItinerary: PropTypes.number,
    activeLeg: PropTypes.object,
    activeSearch: PropTypes.object,
    activeStep: PropTypes.object,
    containerStyle: PropTypes.object,
    customBatchUiBackground: PropTypes.bool,
    enabledSortModes: PropTypes.object,
    itineraries: PropTypes.array,
    itineraryIsExpanded: PropTypes.bool,
    logVariantRows: PropTypes.func,
    modes: PropTypes.object,
    pending: PropTypes.bool,
    popupTarget: PropTypes.string,
    realtimeEffects: PropTypes.object,
    renderSkeletons: PropTypes.bool,
    setActiveItinerary: PropTypes.func,
    setActiveLeg: PropTypes.func,
    setActiveStep: PropTypes.func,
    setItineraryView: PropTypes.func,
    setPopupContent: PropTypes.func,
    setVisibleItinerary: PropTypes.func,
    showDetails: PropTypes.bool,
    showHeaderText: PropTypes.bool,
    sort: PropTypes.object,
    timeFormat: PropTypes.string,
    updateItineraryFilter: PropTypes.func,
    visibleItinerary: PropTypes.number
  }

  static contextType = ComponentContext

  /** Last variant-count signature written to the debug stream. */
  _loggedVariantSignature = null

  _setActiveLeg = (index, leg) => {
    const { activeLeg, setActiveLeg, setItineraryView } = this.props
    const isSameLeg = activeLeg === index
    if (isSameLeg) {
      // If clicking on the same leg again, reset it to null,
      // and show the full itinerary (both desktop and mobile view)
      setActiveLeg(null, null)
      setItineraryView(ItineraryView.FULL)
    } else {
      // Focus on the newly selected leg.
      setActiveLeg(index, leg)
      setItineraryView(ItineraryView.LEG)
    }
  }

  _toggleDetailedItinerary = () => {
    const { setActiveLeg, setItineraryView, showDetails } = this.props
    const newView = showDetails ? ItineraryView.LIST : ItineraryView.FULL
    setItineraryView(newView)
    // Reset the active leg.
    setActiveLeg(null, null)
  }

  _onSortChange = (type) => {
    const { sort, updateItineraryFilter } = this.props
    updateItineraryFilter({ sort: { ...sort, type } })
  }

  _onSortDirChange = () => {
    const { sort, updateItineraryFilter } = this.props
    const direction = sort.direction === 'ASC' ? 'DESC' : 'ASC'
    updateItineraryFilter({ sort: { ...sort, direction } })
  }

  _onViewAllOptions = () => {
    const { itineraryIsExpanded, setActiveItinerary } = this.props

    setActiveItinerary({ index: -1 })

    if (itineraryIsExpanded) {
      this._toggleDetailedItinerary()
    }
  }

  _renderLoadingSpinner = () => {
    const { pending, renderSkeletons } = this.props
    if (!renderSkeletons) {
      return pending ? <Loading /> : null
    }
  }

  _renderLoadingDivs = () => {
    const { itineraries, modes, pending, renderSkeletons } = this.props

    // If renderSkeletons is off, don't render the skeleton-type loading divs
    if (!renderSkeletons) {
      return null
    }

    if (!pending) return null

    // Construct loading divs as placeholders while all itineraries load.
    const count = modes.combinations
      ? modes.combinations.length - itineraries.length
      : 0
    return Array.from({ length: count }, (v, i) => (
      <div className="option default-itin" key={i}>
        <SkeletonTheme color={grey[100]} highlightColor={grey[50]}>
          <Skeleton count={3} />
        </SkeletonTheme>
      </div>
    ))
  }

  _renderItineraryRow = (itinerary, mini = false) => {
    const {
      activeItinerary,
      activeLeg,
      activeStep,
      itineraryIsExpanded,
      realtimeEffects,
      routeLock,
      setActiveItinerary,
      setActiveStep,
      setVisibleItinerary,
      showDetails,
      sort,
      timeFormat,
      visibleItinerary
    } = this.props

    if (!itinerary) return null
    // Hide non-active itineraries.
    const active = itinerary.index === activeItinerary
    const visible = itinerary.index === visibleItinerary
    if (!active && itineraryIsExpanded) return null

    const { ItineraryBody, LegIcon } = this.context
    const ListItem = itineraryIsExpanded ? 'div' : 'li'

    const showRealtimeAnnotation =
      realtimeEffects.isAffectedByRealtimeData &&
      (realtimeEffects.exceedsThreshold || realtimeEffects.routesDiffer)

    const skipsLockedRoute =
      routeLock && !itineraryMatchesLock(itinerary, routeLock)

    return (
      <ListItem
        className="result"
        // Ensure we update if the active itinerary changes.
        key={itinerary.index}
      >
        {skipsLockedRoute && (
          <S.OffRouteNote>
            <FormattedMessage
              id={
                routeLock.scope === 'starting'
                  ? 'components.BatchSearchScreen.routeLockNotStarted'
                  : 'components.BatchSearchScreen.routeLockNotUsed'
              }
              values={{ route: routeLockText(routeLock) }}
            />
          </S.OffRouteNote>
        )}
        <ItineraryBody
          active={active}
          activeLeg={activeLeg}
          activeStep={activeStep}
          expanded={showDetails}
          index={itinerary.index}
          itinerary={itinerary}
          LegIcon={LegIcon}
          mini={mini}
          onClick={active ? this._toggleDetailedItinerary : undefined}
          role="listitem"
          routingType="ITINERARY"
          setActiveItinerary={setActiveItinerary}
          setActiveLeg={this._setActiveLeg}
          setActiveStep={setActiveStep}
          setVisibleItinerary={setVisibleItinerary}
          showRealtimeAnnotation={showRealtimeAnnotation}
          sort={sort}
          timeFormat={timeFormat}
          toggleDetailedItinerary={this._toggleDetailedItinerary}
          visible={visible}
        />
      </ListItem>
    )
  }

  /**
   * Put the variant summary in the debug stream once per distinct result set.
   * Keyed on the counts themselves rather than on the search id, because a
   * search's rows arrive in several batches (one per mode combination) and the
   * useful record is the list as the rider finally saw it. Two searches can of
   * course share a signature; that is fine, because mapStateToProps keys this
   * component on activeSearchId, so a new search remounts it and clears this.
   *
   * Nothing reduces ITINERARY_VARIANT_ROWS, so dispatching from
   * componentDidUpdate cannot feed back into a render.
   */
  _logVariantRows = () => {
    const { logVariantRows, mergedItineraries } = this.props
    if (!logVariantRows || !mergedItineraries?.length) return
    const summary = summariseVariantRows(mergedItineraries)
    const signature = summary.variantCounts.join(',')
    if (signature === this._loggedVariantSignature) return
    this._loggedVariantSignature = signature
    logVariantRows(summary)
  }

  componentDidMount() {
    this._logVariantRows()
  }

  componentDidUpdate(prevProps) {
    this._logVariantRows()
    // If set in URL, set the active itinerary in the state, once.
    const {
      activeItinerary,
      activeSearch,
      itineraries,
      itineraryConfig,
      mergedItineraries,
      pending,
      setActiveItinerary,
      setVisibleItinerary,
      visibleItinerary
    } = this.props
    const {
      ui_activeItinerary: uiActiveItinerary,
      ui_activeItineraryKey: uiActiveItineraryKey
    } = coreUtils.query.getUrlParams() || {}
    if (
      activeSearch &&
      uiActiveItinerary !== undefined &&
      uiActiveItinerary !== '-1'
    ) {
      const restored = resolveUrlItineraryIndex({
        itineraries,
        key: uiActiveItineraryKey,
        pending,
        urlIndex: +uiActiveItinerary
      })
      if (restored !== null && restored !== activeItinerary) {
        setActiveItinerary({ index: restored })
        setVisibleItinerary({ index: restored })
      }
    }

    /**
     * Showing the first result by default is a lot more complicated now that we have
     * fixed indices. We must update the visible itinerary here instead of in the redux state.
     * Also, we need to update whenever new items arrive, to make sure that the highlighted
     * itinerary is indeed the first one.
     *
     * Finally, we need to make sure we only update if the data changes, not if the user actually
     * highlighted something else on their own.
     */
    if (itineraryConfig?.showFirstResultByDefault) {
      if (
        activeItinerary === -1 &&
        (visibleItinerary === null || visibleItinerary === false) &&
        prevProps.mergedItineraries.length !== mergedItineraries.length
      ) {
        setVisibleItinerary({
          index: mergedItineraries?.length > 0 && mergedItineraries?.[0].index
        })
      }
    }
  }

  // eslint-disable-next-line complexity
  render() {
    const {
      activeItinerary,
      activeSearch,
      customBatchUiBackground,
      enabledSortModes,
      errorsOtp2,
      groupItineraries,
      groupTransitModes,
      intl,
      itineraries,
      itineraryIsExpanded,
      mergedItineraries,
      pending,
      popupTarget,
      setPopupContent,
      showHeaderText,
      sort,
      user
    } = this.props

    if (!activeSearch) return null

    // render lists become divs if itinerary is expanded, to avoid rendering a list with list item
    const ListContainer = itineraryIsExpanded ? 'div' : S.ULContainer
    const itinerary = itineraries?.[activeItinerary]

    // This loop determines if an itinerary uses a single or multiple modes
    const groupedMergedItineraries = mergedItineraries.reduce(
      (prev, cur) => {
        // Create a clone of our buckets
        const modeItinMap = clone(prev)
        // We generate a mode string description as this handles
        // a lot of the itinerary processing work for us
        const modeString = getItineraryDescription({
          combineTransitModes: groupTransitModes,
          intl,
          itinerary: cur
        })

        // Identify whether an itinerary uses transit & sort into appropriate bucket
        const transitLegs = cur.legs.filter(isTransitLeg)

        const modeContainer =
          transitLegs.length > 0 ? modeItinMap.multi : modeItinMap.single

        // Now that we know the mode container to place our itinerary in, we do so
        if (!modeContainer[modeString]) modeContainer[modeString] = []
        modeContainer[modeString].push(cur)
        return modeItinMap
      },
      { multi: {}, single: {} }
    )

    return (
      <S.NarrativeItinerariesContainer
        className={`options itinerary ${
          customBatchUiBackground && !itineraryIsExpanded && 'base-color-bg'
        }`}
      >
        <PageTitle
          title={summarizeQuery(activeSearch.query, intl, user.savedLocations)}
        />
        <NarrativeItinerariesHeader
          customBatchUiBackground={customBatchUiBackground}
          enabledSortModes={enabledSortModes}
          itineraries={mergedItineraries}
          itinerary={itinerary}
          itineraryIsExpanded={itineraryIsExpanded}
          onSortChange={this._onSortChange}
          onSortDirChange={this._onSortDirChange}
          onViewAllOptions={this._onViewAllOptions}
          pending={pending}
          popupTarget={popupTarget}
          setPopupContent={setPopupContent}
          showHeaderText={showHeaderText}
          sort={sort}
        />
        <div
          // FIXME: Change to a ul with li children?
          className="list"
          id="itinerary-menu"
          style={{
            flexGrow: '1',
            overflowY: 'auto'
          }}
        >
          {!pending && (
            <ErrorRenderer
              errors={errorsOtp2}
              itineraries={mergedItineraries}
            />
          )}
          {groupItineraries && !itineraryIsExpanded ? (
            Object.keys(groupedMergedItineraries.multi).map((mode) => {
              return (
                <S.ModeResultContainer key={mode}>
                  {/* The header for each mode combination (e.g. "Walk + Transit") is an <h3> element
                          because it falls under the "n Itineraries Found" header, which is an <h2> element. */}
                  <h3>{mode}</h3>
                  <ListContainer>
                    {groupedMergedItineraries.multi[mode].map((itin) =>
                      this._renderItineraryRow(itin)
                    )}
                  </ListContainer>
                </S.ModeResultContainer>
              )
            })
          ) : itineraryIsExpanded ? (
            // This case is for the expanded view of one itinerary.
            <ListContainer>{this._renderItineraryRow(itinerary)}</ListContainer>
          ) : (
            // Let itineraries trickle in.
            <ListContainer>
              {mergedItineraries.map((itin) => this._renderItineraryRow(itin))}
            </ListContainer>
          )}
          {this._renderLoadingDivs()}
          {groupItineraries &&
            !itineraryIsExpanded &&
            Object.keys(groupedMergedItineraries.single).length > 0 && (
              <S.ModeResultContainer>
                {/* The non-transit a11y header is an <h3> element because
                        it falls under the "n Itineraries Found" header, which is an <h2> element. */}
                <InvisibleA11yLabel as="h3">
                  <FormattedMessage id="components.DefaultItinerary.nonTransit" />
                </InvisibleA11yLabel>
                <S.SingleModeRowContainer>
                  {Object.keys(groupedMergedItineraries.single).map((mode) =>
                    groupedMergedItineraries.single[mode].map((itin) =>
                      this._renderItineraryRow(itin, true)
                    )
                  )}
                </S.SingleModeRowContainer>
              </S.ModeResultContainer>
            )}
          {this._renderLoadingSpinner()}
        </div>
      </S.NarrativeItinerariesContainer>
    )
  }
}

// connect to the redux store
const mapStateToProps = (state) => {
  const { config, filter } = state.otp
  const { co2, itinerary, modes } = config
  const { sort } = filter

  const activeSearch = getActiveSearch(state)
  const activeItinerary = activeSearch?.activeItinerary
  const pending = activeSearch?.pending > 0
  const itinsWithCo2 = getActiveItineraries(state)
  const realtimeEffects = getRealtimeEffects(state)
  const urlParams = coreUtils.query.getUrlParams()
  const itineraryView = getItineraryView(urlParams)
  const showDetails =
    itineraryView === ItineraryView.FULL ||
    itineraryView === ItineraryView.LEG ||
    itineraryView === ItineraryView.LEG_HIDDEN
  const {
    customBatchUiBackground,
    defaultFareType,
    groupByMode: groupItineraries,
    groupTransitModes,
    mergeByRouteSignature,
    mergeItineraries,
    showHeaderText,
    sortModes
  } = config.itinerary || false
  // Default to true for backwards compatibility
  const renderSkeletons = !config.itinerary?.hideSkeletons
  const itineraryIsExpanded = isDefined(activeItinerary) && showDetails
  const { localUser, loggedInUser } = state.user
  const user = loggedInUser || localUser

  // Merge duplicate itineraries together and save multiple departure times
  let mergedItineraries
  let allItineraries
  if (mergeItineraries) {
    // eslint-disable-next-line prettier/prettier
    ({ allItineraries, mergedItineraries } = doMergeItineraries(itinsWithCo2, defaultFareType, mergeByRouteSignature))
  } else {
    allItineraries = itinsWithCo2
    mergedItineraries = [...allItineraries]
  }

  // Sort the merged (displayed) itineraries if needed
  sortItinerariesInPlaceIfNeeded(mergedItineraries, state)

  // A two-block bus ride the rider would rather have cycled doesn't get to sit
  // above the same trip without it. Reorders only — nothing is dropped, and the
  // sort above still decides the order within each group. See
  // util/itinerary#demoteTokenTransitHops for the 2026-08-31 602 m case.
  mergedItineraries = demoteTokenTransitHops(mergedItineraries, {
    maxHopMeters: itinerary?.tokenTransitHopMeters,
    toleranceMs:
      itinerary?.tokenTransitHopToleranceMinutes != null
        ? itinerary.tokenTransitHopToleranceMinutes * 60000
        : undefined
  })

  // With routes named, the answer still contains trips that don't honour them:
  // "only these routes" is partitioned (the bike-the-whole-way option OTP
  // returns alongside is worth keeping, just not first) and "start on this
  // route" is filtered, because a first-leg constraint has no server-side
  // expression at all. See util/route-lock#applyRouteLockToItineraries.
  const { routeLock } = state.otp.currentQuery
  mergedItineraries = applyRouteLockToItineraries(mergedItineraries, routeLock)

  return {
    // swap out realtime itineraries with non-realtime depending on boolean
    activeItinerary,
    activeLeg: activeSearch?.activeLeg,
    activeSearch,
    activeStep: activeSearch?.activeStep,
    co2Config: co2,
    customBatchUiBackground,
    enabledSortModes: sortModes,
    errorsOtp2: getActiveSearchErrors(state),
    groupItineraries,
    groupTransitModes,
    itineraries: allItineraries,
    itineraryConfig: itinerary,
    itineraryIsExpanded,
    // use a key so that the NarrativeItineraries component and its state is
    // reset each time a new search is shown
    key: state.otp.activeSearchId,
    mergedItineraries,
    modes,
    pending,
    popupTarget: config.popups?.launchers?.optionFilter,
    realtimeEffects,
    renderSkeletons,
    routeLock,
    showDetails,
    showHeaderText,
    sort,
    timeFormat: coreUtils.time.getTimeFormat(config),
    user,
    visibleItinerary: getVisibleItineraryIndex(state)
  }
}

const mapDispatchToProps = (dispatch) => {
  // FIXME: update signature of these methods,
  // so that only one argument is passed,
  // e.g. setActiveLeg({ index, leg })
  return {
    logVariantRows: (payload) => dispatch(logItineraryVariantRows(payload)),
    setActiveItinerary: (payload) => dispatch(setActiveItinerary(payload)),
    // FIXME
    setActiveLeg: (index, leg) => {
      dispatch(setActiveLeg({ index, leg }))
    },
    // FIXME
    setActiveStep: (index, step) => {
      dispatch(setActiveStep({ index, step }))
    },
    setItineraryView: (payload) =>
      dispatch(uiActions.setItineraryView(payload)),
    setPopupContent: (payload) => dispatch(uiActions.setPopupContent(payload)),
    setVisibleItinerary: (payload) => dispatch(setVisibleItinerary(payload)),
    updateItineraryFilter: (payload) => dispatch(updateItineraryFilter(payload))
  }
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(injectIntl(NarrativeItineraries))
