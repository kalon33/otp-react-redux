import { ChevronRight } from '@styled-icons/fa-solid/ChevronRight'
import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { Plus } from '@styled-icons/fa-solid/Plus'
import React, { useContext } from 'react'
import styled from 'styled-components'

import { ComponentContext } from '../../../util/contexts'
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
import {
  SettingsCard,
  SettingsList,
  SettingsPage,
  SettingsSection
} from '../settings-list'
import {
  TnListRow,
  TnListRowBody,
  TnListRowIcon,
  TnListRowSubtitle,
  TnListRowTitle,
  TnListRowTrail
} from '../../util/tn-styled'
import { UserSavedLocation } from '../types'
import AppFrame from '../../app/app-frame'
import InvisibleA11yLabel from '../../util/invisible-a11y-label'
import Link from '../../util/link'
import PageTitle from '../../util/page-title'

interface Props {
  savedLocations: UserSavedLocation[]
}

/** A saved place as a list row: the whole row opens its editor. */
const PlaceRow = styled(TnListRow)`
  /* A place with no address yet reads as a prompt, not a value. */
  &[data-unset] ${TnListRowSubtitle} {
    color: var(--tn-accent);
  }
`

/** "Add another place": an accent row of its own, under the list. */
const AddRow = styled(TnListRow)`
  color: var(--tn-accent);
  font: 600 16px/22px var(--tn-font);

  &[href]:hover,
  &[href]:focus {
    color: var(--tn-accent);
  }
  ${TnListRowIcon} {
    color: var(--tn-accent);
  }
  ${TnListRowIcon} svg {
    height: 16px;
    width: 16px;
  }
`

/**
 * Lists the local user's saved places (Home, Work, and custom named ones)
 * for editing and adding; deleting is on each place's own editor screen.
 * Unlike FavoritePlaceList, this screen works entirely on-device: no account,
 * no login.
 */
const LocalPlacesScreen = ({ savedLocations }: Props) => {
  const intl = useIntl()
  // @ts-expect-error TODO: Add types to ComponentContext
  const { SvgIcon } = useContext(ComponentContext)
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

  return (
    <AppFrame title={heading}>
      <PageTitle title={heading} />
      <h1 className="tn-page-title">{heading}</h1>
      <SettingsPage>
        <SettingsSection>
          <SettingsList>
            {places.map((place: UserSavedLocation, index: number) => {
              const mainText = getPlaceMainText(place, intl)
              const detailText = getPlaceDetail(place, intl)
              return (
                <li key={place.id || place.type || index}>
                  <PlaceRow
                    as={Link}
                    data-unset={isBlank(place.address) || undefined}
                    title={editActionText}
                    to={`${LOCAL_PLACES_PATH}/${
                      isHomeOrWork(place) ? place.type : place.id
                    }`}
                  >
                    <TnListRowIcon aria-hidden>
                      <SvgIcon
                        iconName={
                          // Entries saved by the legacy map-popup path carry no icon.
                          place.icon ||
                          (
                            PLACE_TYPES[
                              place.type as keyof typeof PLACE_TYPES
                            ] || {}
                          ).icon
                        }
                      />
                    </TnListRowIcon>
                    <TnListRowBody>
                      <TnListRowTitle>{mainText}</TnListRowTitle>
                      <TnListRowSubtitle>
                        <InvisibleA11yLabel> - </InvisibleA11yLabel>
                        {detailText}
                      </TnListRowSubtitle>
                      <InvisibleA11yLabel>
                        {' '}
                        [{editActionText}]
                      </InvisibleA11yLabel>
                    </TnListRowBody>
                    <TnListRowTrail aria-hidden>
                      <ChevronRight />
                    </TnListRowTrail>
                  </PlaceRow>
                </li>
              )
            })}
          </SettingsList>
        </SettingsSection>

        <SettingsSection>
          <SettingsCard>
            <AddRow as={Link} to={`${LOCAL_PLACES_PATH}/new`}>
              <TnListRowIcon aria-hidden>
                <Plus />
              </TnListRowIcon>
              <FormattedMessage id="components.FavoritePlaceList.addAnotherPlace" />
            </AddRow>
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    </AppFrame>
  )
}

// connect to the redux store

const mapStateToProps = (state: any) => ({
  savedLocations: state.user.localUser?.savedLocations || []
})

export default connect(mapStateToProps)(LocalPlacesScreen)
