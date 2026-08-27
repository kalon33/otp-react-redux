import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { Plus } from '@styled-icons/fa-solid/Plus'
import React from 'react'

import * as userActions from '../../../actions/user'
import {
  getPlaceDetail,
  getPlaceMainText,
  isHome,
  isHomeOrWork,
  isWork,
  PLACE_TYPES
} from '../../../util/user'
import { isBlank } from '../../../util/ui'
import { isCustomPlace } from '../../../util/saved-places'
import { LOCAL_PLACES_PATH } from '../../../util/constants'
import { UnpaddedList } from '../../form/styled'
import { UserSavedLocation } from '../types'
import AppFrame from '../../app/app-frame'
import PageTitle from '../../util/page-title'

import { NewPlaceButton, StyledFavoritePlace } from './styled'

interface Props {
  deleteUserPlace: (place: UserSavedLocation | string, intl: unknown) => void
  savedLocations: UserSavedLocation[]
}

/**
 * Lists the local user's saved places (Home, Work, and custom named ones)
 * for editing, adding, and deleting. Unlike FavoritePlaceList, this screen
 * works entirely on-device: no account, no login.
 */
const LocalPlacesScreen = ({ deleteUserPlace, savedLocations }: Props) => {
  const intl = useIntl()
  const heading = intl.formatMessage({
    id: 'components.SavedPlacesScreen.heading'
  })
  const editActionText = intl.formatMessage({
    id: 'components.FavoritePlaceList.editThisPlace'
  })

  // Home and Work always show (with a "set address" prompt when unset);
  // custom places follow. Config-provided "suggested" places are not
  // editable, so they are not listed here.
  const places = [
    savedLocations.find(isHome) || { ...PLACE_TYPES.home, address: '' },
    savedLocations.find(isWork) || { ...PLACE_TYPES.work, address: '' },
    ...savedLocations.filter(isCustomPlace)
  ]

  const handleDelete = (place: UserSavedLocation) => {
    if (
      window.confirm(
        intl.formatMessage({ id: 'actions.user.confirmDeletePlace' })
      )
    ) {
      deleteUserPlace(place, intl)
    }
  }

  return (
    <AppFrame>
      <PageTitle title={heading} />
      <h1>{heading}</h1>
      <UnpaddedList>
        {places.map((place: UserSavedLocation, index: number) => (
          <StyledFavoritePlace
            actionText={editActionText}
            detailText={getPlaceDetail(place, intl)}
            icon={
              // Entries saved by the legacy map-popup path carry no icon.
              place.icon ||
              (PLACE_TYPES[place.type as keyof typeof PLACE_TYPES] || {}).icon
            }
            key={place.id || place.type || index}
            mainText={getPlaceMainText(place, intl)}
            onDelete={
              !isBlank(place.address) ? () => handleDelete(place) : undefined
            }
            path={`${LOCAL_PLACES_PATH}/${
              isHomeOrWork(place) ? place.type : place.id
            }`}
            title={editActionText}
          />
        ))}
      </UnpaddedList>

      <NewPlaceButton
        className="btn btn-primary"
        to={`${LOCAL_PLACES_PATH}/new`}
      >
        <Plus size={10} />
        <FormattedMessage id="components.FavoritePlaceList.addAnotherPlace" />
      </NewPlaceButton>
    </AppFrame>
  )
}

// connect to the redux store

const mapStateToProps = (state: any) => ({
  savedLocations: state.user.localUser?.savedLocations || []
})

const mapDispatchToProps = {
  deleteUserPlace: userActions.deleteUserPlace
}

export default connect(mapStateToProps, mapDispatchToProps)(LocalPlacesScreen)
