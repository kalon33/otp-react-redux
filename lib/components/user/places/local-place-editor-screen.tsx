import { connect } from 'react-redux'
import { Form, Formik } from 'formik'
import { FormattedMessage, useIntl } from 'react-intl'
import { Trash } from '@styled-icons/fa-solid/Trash'
import clone from 'clone'
import coreUtils from '@opentripplanner/core-utils'
import React, { useState } from 'react'
import styled from 'styled-components'
// @ts-expect-error Package yup does not have type declarations.
import * as yup from 'yup'

import * as userActions from '../../../actions/user'
import {
  convertToLegacyLocation,
  convertToPlace,
  isHomeOrWork,
  PLACE_TYPES
} from '../../../util/user'
import { DeleteFormButton } from '../delete-form'
import { getFormattedPlaces } from '../../../util/i18n'
import { IconWithText } from '../../util/styledIcon'
import { isBlank, navigateBack } from '../../../util/ui'
import { PageHeading } from '../styled'
import { PLACE_NAME_MAX_LENGTH } from '../../../util/constants'
import { UserSavedLocation } from '../types'
import AppFrame from '../../app/app-frame'
import FormNavigationButtons from '../form-navigation-buttons'
import PageTitle from '../../util/page-title'

import PlaceEditor from './place-editor'

const { randId } = coreUtils.storage

// Make space between place details and form buttons.
const Container = styled.div`
  margin-bottom: 100px;
  @media (max-width: 768px) {
    margin-bottom: 50px;
  }
`

/**
 * Obtains a schema that validates the given place name against
 * other place names used by the user, including 'Work' and 'Home'.
 * (The error strings are text constants for the corresponding
 * components.FavoritePlaceScreen validation messages.)
 */
function getFullValidationSchema(
  places: UserSavedLocation[],
  place?: UserSavedLocation | null
) {
  const otherPlaceNames = (
    place
      ? places.filter((pl) => !isBlank(pl.name) && pl.name !== place.name)
      : places
  ).map((pl) => pl.name)

  return yup.object({
    address: yup.string().required('invalid-address'),
    name: yup
      .string()
      .required('invalid-name')
      .notOneOf(otherPlaceNames, 'placename-already-used')
      .max(PLACE_NAME_MAX_LENGTH, 'placename-too-long')
  })
}

interface Props {
  deleteUserPlace: (place: UserSavedLocation, intl: unknown) => void
  location: { search: string }
  match: { params: { id: string } }
  rememberPlace: (
    placeTypeLocation: { location: UserSavedLocation; type?: string },
    intl: unknown
  ) => void
  savedLocations: UserSavedLocation[]
}

/**
 * Lets the local user edit a new or existing saved place entirely on-device
 * (the localStorage counterpart of the Auth0-gated FavoritePlaceScreen).
 * Routes: /places/new (optionally prefilled from ?lat=&lon=&address=),
 * /places/home, /places/work, /places/<place-id>.
 */
const LocalPlaceEditorScreen = ({
  deleteUserPlace,
  location,
  match,
  rememberPlace,
  savedLocations
}: Props) => {
  const intl = useIntl()
  const placeId = match.params.id
  const isNewPlace = placeId === 'new'
  // Mint the id once so re-renders (e.g. as the user types) do not fork it.
  const [newPlaceId] = useState(() => `place-${randId()}`)

  const place: UserSavedLocation | null = (() => {
    if (isNewPlace) {
      const params = new URLSearchParams(location.search)
      const lat = parseFloat(params.get('lat') || '')
      const lon = parseFloat(params.get('lon') || '')
      const newPlace: UserSavedLocation = {
        ...PLACE_TYPES.custom,
        address: params.get('address') || '',
        id: newPlaceId,
        name: ''
      }
      if (!isNaN(lat) && !isNaN(lon)) {
        newPlace.lat = lat
        newPlace.lon = lon
      }
      return newPlace
    }
    if (placeId === 'home' || placeId === 'work') {
      const existing = savedLocations.find((l) => l.type === placeId)
      // convertToPlace normalizes entries saved in the legacy location shape
      // (e.g. by the map endpoint popup); home/work keep name === address,
      // so it is a no-op for entries already in place shape.
      const fixedPlace: UserSavedLocation = existing
        ? convertToPlace(clone(existing))
        : { ...PLACE_TYPES[placeId], address: '' }
      // Like FavoritePlaceScreen: name fixed places after their type
      // (PlaceEditor hides the name field for them).
      fixedPlace.name = placeId
      return fixedPlace
    }
    const existing = savedLocations.find((l) => l.id === placeId)
    if (!existing) return null
    const editedPlace = clone(existing)
    if (editedPlace.name === null) editedPlace.name = ''
    return editedPlace
  })()

  const isFixed = place && isHomeOrWork(place)

  let heading: string
  if (!place) {
    heading = intl.formatMessage({
      id: 'components.FavoritePlaceScreen.placeNotFound'
    })
  } else if (isNewPlace) {
    heading = intl.formatMessage({
      id: 'components.FavoritePlaceScreen.addNewPlace'
    })
  } else if (isFixed) {
    heading = intl.formatMessage(
      { id: 'components.FavoritePlaceScreen.editPlace' },
      { placeName: getFormattedPlaces(place.type, intl) }
    )
  } else {
    heading = intl.formatMessage({
      id: 'components.FavoritePlaceScreen.editPlaceGeneric'
    })
  }

  const handleSave = (placeToSave: UserSavedLocation) => {
    // Update the icon for the place type.
    // @ts-expect-error TODO: add types to PLACE_TYPES
    placeToSave.icon = PLACE_TYPES[placeToSave.type].icon
    rememberPlace(
      {
        // Home and Work are persisted in the legacy location shape for
        // compatibility with the map endpoint popup save path; custom
        // places round-trip in place shape via util/saved-places.
        location: isHomeOrWork(placeToSave)
          ? convertToLegacyLocation(placeToSave)
          : placeToSave,
        type: placeToSave.type
      },
      intl
    )
    navigateBack()
  }

  const handleDelete = (placeToDelete: UserSavedLocation) => {
    if (
      !window.confirm(
        intl.formatMessage({ id: 'actions.user.confirmDeletePlace' })
      )
    ) {
      return
    }
    deleteUserPlace(placeToDelete, intl)
    navigateBack()
  }

  return (
    <AppFrame>
      <PageTitle title={heading} />
      <Formik
        initialValues={place || {}}
        onSubmit={handleSave}
        validateOnBlur
        // Avoid validating on change as it is annoying. Validating on blur is enough.
        validateOnChange={false}
        validationSchema={getFullValidationSchema(savedLocations, place)}
      >
        {(formikProps) => (
          <Form noValidate>
            <div>
              <PageHeading as="h1">{heading}</PageHeading>
            </div>
            <Container>
              {place ? (
                <PlaceEditor {...formikProps} />
              ) : (
                <p>
                  <FormattedMessage id="components.FavoritePlaceScreen.placeNotFoundDescription" />
                </p>
              )}
            </Container>

            <FormNavigationButtons
              backButton={{
                onClick: navigateBack,
                text: <FormattedMessage id="common.forms.back" />
              }}
              extraButton={
                !isNewPlace && place && !isBlank(place.address)
                  ? {
                      content: (
                        <DeleteFormButton onClick={() => handleDelete(place)}>
                          <IconWithText Icon={Trash}>
                            <FormattedMessage id="components.Place.deleteThisPlace" />
                          </IconWithText>
                        </DeleteFormButton>
                      )
                    }
                  : undefined
              }
              okayButton={
                place
                  ? {
                      text: <FormattedMessage id="common.forms.save" />,
                      type: 'submit'
                    }
                  : undefined
              }
            />
          </Form>
        )}
      </Formik>
    </AppFrame>
  )
}

// connect to the redux store

const mapStateToProps = (state: any) => ({
  savedLocations: state.user.localUser?.savedLocations || []
})

const mapDispatchToProps = {
  deleteUserPlace: userActions.deleteUserPlace,
  rememberPlace: userActions.rememberPlace
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(LocalPlaceEditorScreen)
