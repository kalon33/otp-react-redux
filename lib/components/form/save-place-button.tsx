import { connect } from 'react-redux'
import { Star } from '@styled-icons/fa-regular/Star'
import { useIntl } from 'react-intl'
import coreUtils from '@opentripplanner/core-utils'
import React from 'react'
import styled from 'styled-components'

import * as uiActions from '../../actions/ui'
import { getUserLocations } from '../../util/user'
import { LOCAL_PLACES_PATH } from '../../util/constants'

const { matchLatLon } = coreUtils.map

const StyledSaveButton = styled.button`
  align-items: center;
  background: none;
  border: none;
  color: #0b6ea8;
  display: flex;
  font-weight: 600;
  gap: 6px;
  padding: 6px 0;
`

interface QueryLocation {
  category?: string
  lat?: number
  lon?: number
  name?: string
}

interface Props {
  place: QueryLocation | null
  routeTo: (url: string, replaceSearch?: string) => void
}

/**
 * Offers to save the location currently in the search form (destination
 * first, else origin) as a named place. Hidden when neither location
 * qualifies: unset, the rider's live position, or already saved.
 * Tapping opens the on-device place editor prefilled with the location.
 */
const SavePlaceButton = ({ place, routeTo }: Props) => {
  const intl = useIntl()
  if (!place) return null
  const handleClick = () =>
    routeTo(
      `${LOCAL_PLACES_PATH}/new`,
      `?lat=${place.lat}&lon=${place.lon}&address=${encodeURIComponent(
        place.name || ''
      )}`
    )
  return (
    <StyledSaveButton onClick={handleClick} type="button">
      <Star size={14} />
      {intl.formatMessage({
        defaultMessage: 'Save this place',
        id: 'components.SavedPlacesScreen.saveThisPlace'
      })}
    </StyledSaveButton>
  )
}

// connect to the redux store

const mapStateToProps = (state: any) => {
  const { from, to } = state.otp.currentQuery
  const { saved } = getUserLocations(state)
  const isSavable = (loc: QueryLocation | null) =>
    loc &&
    loc.lat != null &&
    loc.lon != null &&
    loc.category !== 'CURRENT_LOCATION' &&
    !saved.some((s: QueryLocation) => matchLatLon(s as any, loc as any))
  return {
    place: isSavable(to) ? to : isSavable(from) ? from : null
  }
}

const mapDispatchToProps = {
  routeTo: uiActions.routeTo
}

export default connect(mapStateToProps, mapDispatchToProps)(SavePlaceButton)
