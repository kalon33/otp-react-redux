import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'

import * as goModeActions from '../../actions/go-mode'
import { autoSwitchCopy } from '../../util/go-mode/notification-service'
import type { AutoUndo } from '../../util/go-mode/auto-switch'

import {
  FasterRouteBar,
  FasterRouteDetail,
  FasterRouteKeepButton,
  RerouteActions,
  RerouteCard,
  RerouteCardTitle,
  RerouteSwitchButton
} from './styled'

/**
 * "Switched · 6 min faster" / "14" — Auto has switched the trip (65.2, cycle
 * 36 B2), with Undo until the old bus leaves or 5 min (aboard: until a minute
 * before the new stop). The faster-route card's bar, card, words and buttons,
 * verbatim, in its place: Undo where Keep mine is, OK where Switch is. The
 * words are autoSwitchCopy's, the same as the push.
 */
interface OwnProps {
  /** Injected in tests and the demo gallery; otherwise read off the store. */
  undo?: AutoUndo | null
}

interface Props extends OwnProps {
  dismissAutoUndo: () => void
  undoAutoSwitch: () => Promise<void> | void
}

function AutoSwitchCard({
  dismissAutoUndo,
  undo,
  undoAutoSwitch
}: Props): JSX.Element | null {
  const intl = useIntl()
  if (!undo) return null
  const { detail, title } = autoSwitchCopy(undo, intl)
  return (
    <FasterRouteBar>
      <RerouteCard className="auto-switch-card" role="status">
        <div>
          <RerouteCardTitle>
            {intl.formatMessage(
              {
                defaultMessage: 'Switched · {title}',
                id: 'components.GoMode.auto.switchedTitle'
              },
              { title }
            )}
          </RerouteCardTitle>
          <FasterRouteDetail>{detail}</FasterRouteDetail>
        </div>
        <RerouteActions>
          <RerouteSwitchButton onClick={() => dismissAutoUndo()} type="button">
            {intl.formatMessage({
              defaultMessage: 'OK',
              id: 'components.GoMode.auto.ok'
            })}
          </RerouteSwitchButton>
          <FasterRouteKeepButton onClick={() => undoAutoSwitch()} type="button">
            {intl.formatMessage({
              defaultMessage: 'Undo',
              id: 'components.GoMode.auto.undo'
            })}
          </FasterRouteKeepButton>
        </RerouteActions>
      </RerouteCard>
    </FasterRouteBar>
  )
}

const mapStateToProps = (state: any, ownProps: OwnProps) => ({
  undo:
    ownProps.undo !== undefined
      ? ownProps.undo
      : state.otp?.goMode?.auto?.undo ?? null
})

const mapDispatchToProps = {
  dismissAutoUndo: goModeActions.dismissAutoUndo,
  undoAutoSwitch: goModeActions.undoAutoSwitch
}

export default connect(mapStateToProps, mapDispatchToProps)(AutoSwitchCard)
