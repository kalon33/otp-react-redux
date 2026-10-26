import { useIntl } from 'react-intl'
import React, { useState } from 'react'

import type { AutoPreset } from '../../util/go-mode/auto-priority'

import {
  BoardingOverlay,
  BoardingSheet,
  BoardingSubtitle,
  BoardingTitle,
  RerouteActions,
  RerouteKeepButton,
  RerouteSwitchButton,
  SheetCloseButton,
  SheetHeader
} from './styled'
import AutoPresetPicker from './AutoPresetPicker'

/**
 * "Start when I leave" (65.2, cycle 36 B4): the arm card. The preset sheet's
 * overlay, sheet and picker (shared with B2), preselected to the preset last
 * picked on this device.
 *
 * Before arming: the pick is the card's own until "Start when I leave" — that
 * arms the trip and makes the pick the remembered preset; Cancel leaves both
 * as they were. Once armed (reopened from the banner): a pick applies at once,
 * to the armed trip and the remembered preset; "Don't start" drops the arm.
 */
interface Props {
  /** null: not armed yet (the setup card). */
  armed: { expiresAtMs: number; starting: boolean } | null
  onArm?: (preset: AutoPreset) => void
  /** Setup: Cancel. Armed: "Don't start". */
  onCancel: () => void
  onClose: () => void
  /** Armed only: a preset picked on the card. */
  onPick?: (preset: AutoPreset) => void
  preset: AutoPreset
}

const BUTTON_STYLE = { minHeight: 44 }

export default function AutoArmCard({
  armed,
  onArm,
  onCancel,
  onClose,
  onPick,
  preset
}: Props): JSX.Element {
  const intl = useIntl()
  const [picked, setPicked] = useState<AutoPreset>(preset)
  const selected = armed ? preset : picked
  const title = intl.formatMessage({
    defaultMessage: 'Start when I leave',
    id: 'components.GoMode.autoArm.title'
  })
  const subtitle = !armed
    ? intl.formatMessage({
        defaultMessage:
          'The trip starts in Auto when you head out. Keep the app open.',
        id: 'components.GoMode.autoArm.setupHint'
      })
    : armed.starting
    ? intl.formatMessage({
        defaultMessage: 'Finding the best route from here…',
        id: 'components.GoMode.autoArm.starting'
      })
    : intl.formatMessage(
        {
          defaultMessage: 'Waiting for you to leave · until {time}',
          id: 'components.GoMode.autoArm.waitingUntil'
        },
        {
          time: new Date(armed.expiresAtMs).toLocaleTimeString(intl.locale, {
            hour: 'numeric',
            minute: '2-digit'
          })
        }
      )
  return (
    <>
      <BoardingOverlay onClick={onClose} />
      <BoardingSheet aria-label={title} className="auto-arm-card" role="dialog">
        <SheetHeader>
          <BoardingTitle>{title}</BoardingTitle>
          <SheetCloseButton
            aria-label={intl.formatMessage({
              defaultMessage: 'Close',
              id: 'components.GoMode.auto.close'
            })}
            onClick={onClose}
            style={{ minHeight: 44, minWidth: 44 }}
            type="button"
          >
            ×
          </SheetCloseButton>
        </SheetHeader>
        <BoardingSubtitle>{subtitle}</BoardingSubtitle>
        <AutoPresetPicker
          name={armed ? 'auto-arm-preset-armed' : 'auto-arm-preset'}
          onPick={(p) => (armed ? onPick?.(p) : setPicked(p))}
          selected={selected}
        />
        <RerouteActions>
          <RerouteKeepButton
            className="auto-arm-cancel"
            onClick={onCancel}
            style={BUTTON_STYLE}
            type="button"
          >
            {armed
              ? intl.formatMessage({
                  defaultMessage: "Don't start",
                  id: 'components.GoMode.autoArm.disarm'
                })
              : intl.formatMessage({
                  defaultMessage: 'Cancel',
                  id: 'components.GoMode.autoArm.cancel'
                })}
          </RerouteKeepButton>
          <RerouteSwitchButton
            className="auto-arm-confirm"
            onClick={() => (armed ? onClose() : onArm?.(picked))}
            style={BUTTON_STYLE}
            type="button"
          >
            {armed
              ? intl.formatMessage({
                  defaultMessage: 'OK',
                  id: 'components.GoMode.auto.ok'
                })
              : title}
          </RerouteSwitchButton>
        </RerouteActions>
      </BoardingSheet>
    </>
  )
}
