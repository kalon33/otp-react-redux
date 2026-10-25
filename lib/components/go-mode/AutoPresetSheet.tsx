import { useIntl } from 'react-intl'
import React from 'react'

import { AUTO_PRESETS } from '../../util/go-mode/auto-priority'
import type { AutoPreset } from '../../util/go-mode/auto-priority'

import { autoPresetHint, autoPresetLabel } from './auto-preset-copy'
import {
  AutoPresetRow,
  BoardingOverlay,
  BoardingSheet,
  BoardingTitle,
  RerouteKeepButton,
  SheetCloseButton,
  SheetHeader,
  VehicleDetail,
  VehicleInfo,
  VehicleLabel
} from './styled'

/**
 * How Auto judges (65.2, cycle 36 B2; rider Q1 = C): four presets, one radio
 * row each — the name and its rule in one line. Picking one turns Auto on
 * with it and remembers it on the device; "Turn off Auto" goes back to tap
 * cards only. The boarding sheet's overlay, sheet and rows, as the bus list
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
        <div role="radiogroup">
          {AUTO_PRESETS.map((p) => (
            <AutoPresetRow
              $selected={on && p === preset}
              as="label"
              className="auto-preset-row"
              key={p}
            >
              <input
                checked={on && p === preset}
                name="auto-preset"
                onChange={() => onPick(p)}
                type="radio"
                value={p}
              />
              <VehicleInfo>
                <VehicleLabel>{autoPresetLabel(p, intl)}</VehicleLabel>
                <VehicleDetail>{autoPresetHint(p, intl)}</VehicleDetail>
              </VehicleInfo>
            </AutoPresetRow>
          ))}
        </div>
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
