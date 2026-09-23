import { Briefcase } from '@styled-icons/fa-solid/Briefcase'
import { Clock } from '@styled-icons/fa-regular/Clock'
import { connect } from 'react-redux'
import { Home } from '@styled-icons/fa-solid/Home'
import { IntlShape, useIntl } from 'react-intl'
import { MapMarkerAlt } from '@styled-icons/fa-solid/MapMarkerAlt'
import { Plus } from '@styled-icons/fa-solid/Plus'
import coreUtils from '@opentripplanner/core-utils'
import React from 'react'
import styled from 'styled-components'

import * as mapActions from '../../actions/map'
import * as uiActions from '../../actions/ui'
import { getUserLocations, isHome, isWork } from '../../util/user'
import { LOCAL_PLACES_PATH } from '../../util/constants'

const { matchLatLon } = coreUtils.map

export interface ChipPlace {
  address?: string
  icon?: string
  id?: string
  lat?: number
  lon?: number
  name?: string
  timestamp?: number
  type?: string
}

export type ChipKind = 'home' | 'work' | 'saved' | 'recent'

export interface PlaceChip {
  kind: ChipKind
  place: ChipPlace
}

const hasCoords = (p: ChipPlace) => p && p.lat != null && p.lon != null

/**
 * The chips, in the order the rider sees them (backlog 28.3): Home and Work
 * (only when set), then the custom saved places, then the single most recent
 * place that is not already one of those chips. Config-suggested locations are
 * not the rider's places and are left out.
 */
export function getPlaceChips(
  saved: ChipPlace[] = [],
  recent: ChipPlace[] = []
): PlaceChip[] {
  const usable = saved.filter(hasCoords)
  const home = usable.find(isHome)
  const work = usable.find(isWork)
  const chips: PlaceChip[] = []
  if (home) chips.push({ kind: 'home', place: home })
  if (work) chips.push({ kind: 'work', place: work })
  usable
    .filter(
      (p) =>
        !isHome(p) && !isWork(p) && p.type !== 'suggested' && p.type !== 'stop'
    )
    .forEach((place) => chips.push({ kind: 'saved', place }))
  const latest = recent
    .filter(hasCoords)
    .filter((r) => !chips.some((c) => matchLatLon(c.place as any, r as any)))
    // Newest first; a stable sort keeps list order (newest-unshifted) on ties.
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0]
  if (latest) chips.push({ kind: 'recent', place: latest })
  return chips
}

function chipLabel(chip: PlaceChip, intl: IntlShape): string {
  const { kind, place } = chip
  if (kind === 'home') {
    return intl.formatMessage({ id: 'components.PlacesChips.home' })
  }
  if (kind === 'work') {
    return intl.formatMessage({ id: 'components.PlacesChips.work' })
  }
  const text = place.name || place.address || ''
  // A recent is a full geocoder address; the street part is enough on a chip.
  return kind === 'recent' ? text.split(',')[0] : text
}

const ICONS = {
  home: Home,
  recent: Clock,
  saved: MapMarkerAlt,
  work: Briefcase
}

const Container = styled.div`
  padding: 10px 0 4px;
`

const Heading = styled.div`
  color: #666;
  font-size: 11px;
  letter-spacing: 0.06em;
  margin-bottom: 8px;
  text-transform: uppercase;
`

const ChipList = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
`

// The toggle look from the same-shape variants control (#eef1f6 on #c9d0dc,
// ink #17314d, 44 px thumb target), rounded into a chip.
const Chip = styled.button`
  align-items: center;
  background: #eef1f6;
  border: 1px solid #c9d0dc;
  border-radius: 22px;
  color: #17314d;
  cursor: pointer;
  display: inline-flex;
  font-size: 15px;
  font-weight: 600;
  gap: 7px;
  max-width: 100%;
  min-height: 44px;
  padding: 8px 14px;

  svg {
    flex: none;
    height: 16px;
    width: 16px;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover {
    background: #e2e7f0;
  }

  &[aria-pressed='true'] {
    background: #2196f3;
    border-color: #2196f3;
    color: #fff;
  }

  &:focus-visible {
    outline: 3px solid #2196f3;
    outline-offset: 1px;
  }

  &.add {
    background: #fff;
    border-style: dashed;
    color: #666;
    font-weight: 500;
  }
`

interface Props {
  chips: PlaceChip[]
  onLocationSelected: (
    intl: IntlShape,
    e: { location: ChipPlace; locationType: string; resultType: string }
  ) => void
  /** What the Plan button does — a second tap on the selected chip plans. */
  onPlanTrip: () => void
  routeTo: (url: string) => void
  to: ChipPlace | null | undefined
}

/**
 * "Your places" on the mobile search form (backlog 28.3): the rider's saved
 * places one tap from the destination box. A tap fills the destination the
 * same way picking the place under "Set Destination" does; a tap on the chip
 * that is already the destination plans the trip.
 */
export const PlacesChips = ({
  chips,
  onLocationSelected,
  onPlanTrip,
  routeTo,
  to
}: Props): JSX.Element | null => {
  const intl = useIntl()
  if (chips.length === 0) return null
  const heading = intl.formatMessage({ id: 'components.PlacesChips.heading' })
  return (
    <Container className="places-chips">
      <Heading id="places-chips-heading">{heading}</Heading>
      <ChipList aria-labelledby="places-chips-heading">
        {chips.map((chip) => {
          const { kind, place } = chip
          const Icon = ICONS[kind]
          const label = chipLabel(chip, intl)
          const selected = !!to && matchLatLon(to as any, place as any)
          return (
            <li key={`${kind}-${place.id || place.type}-${place.lat}`}>
              <Chip
                aria-pressed={selected}
                onClick={() => {
                  if (selected) onPlanTrip()
                  else {
                    onLocationSelected(intl, {
                      location: place,
                      locationType: 'to',
                      resultType: 'SAVED'
                    })
                  }
                }}
                title={
                  kind === 'recent'
                    ? intl.formatMessage(
                        { id: 'components.PlacesChips.recent' },
                        { place: place.name || place.address }
                      )
                    : place.address || place.name
                }
                type="button"
              >
                <Icon aria-hidden />
                <span>{label}</span>
              </Chip>
            </li>
          )
        })}
        <li>
          <Chip
            className="add"
            onClick={() => routeTo(`${LOCAL_PLACES_PATH}/new`)}
            title={intl.formatMessage({
              id: 'components.PlacesChips.addPlace'
            })}
            type="button"
          >
            <Plus aria-hidden />
            <span>
              {intl.formatMessage({ id: 'components.PlacesChips.add' })}
            </span>
          </Chip>
        </li>
      </ChipList>
    </Container>
  )
}

const mapStateToProps = (state: any) => {
  const { recent, saved } = getUserLocations(state)
  return {
    chips: getPlaceChips(saved, recent),
    to: state.otp.currentQuery.to
  }
}

const mapDispatchToProps = {
  onLocationSelected: mapActions.onLocationSelected,
  routeTo: uiActions.routeTo
}

export default connect(mapStateToProps, mapDispatchToProps)(PlacesChips)
