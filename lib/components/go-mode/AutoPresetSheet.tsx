import { useIntl } from 'react-intl'
import React from 'react'

import type { AutoPreset } from '../../util/go-mode/auto-priority'

import {
  BoardingOverlay,
  BoardingSheet,
  BoardingTitle,
  RerouteKeepButton,
  SheetCloseButton,
  SheetHeader
} from './styled'
import AutoPresetPicker from './AutoPresetPicker'

/**
 * How Auto judges (65.2, cycle 36 B2; rider Q1 = C): four presets, one radio
 * row each — the name and its rule in one line (AutoPresetPicker, shared
 * with the arm card). Picking one turns Auto on with it and remembers it on
 * the device; "Turn off Auto" goes back to tap cards only. The boarding sheet's overlay, sheet and rows, as the bus list
 * uses them.
 */
interface Props {
  on: boolean
  onClose: () => void
  onPick: (preset: AutoPreset) => void
  onTurnOff: () => void
  preset: AutoPreset
}

export default function AutoPresetSheet({
  on,
  onClose,
  onPick,
  onTurnOff,
  preset
}: Props): JSX.Element {
  const intl = useIntl()
  const title = intl.formatMessage({
    defaultMessage: 'Auto',
    id: 'components.GoMode.auto.sheetTitle'
  })
  return (
    <>
      <BoardingOverlay onClick={onClose} />
      <BoardingSheet aria-label={title} role="dialog">
        <SheetHeader>
          <BoardingTitle>{title}</BoardingTitle>
          <SheetCloseButton
            aria-label={intl.formatMessage({
              defaultMessage: 'Close',
              id: 'components.GoMode.auto.close'
            })}
            onClick={onClose}
            type="button"
          >
            ×
          </SheetCloseButton>
        </SheetHeader>
        <AutoPresetPicker
          name="auto-preset"
          onPick={onPick}
          selected={on ? preset : null}
        />
        {on && (
          <RerouteKeepButton
            onClick={onTurnOff}
            style={{ minHeight: 44, width: '100%' }}
            type="button"
          >
            {intl.formatMessage({
              defaultMessage: 'Turn off Auto',
              id: 'components.GoMode.auto.turnOff'
            })}
          </RerouteKeepButton>
        )}
      </BoardingSheet>
    </>
  )
}
