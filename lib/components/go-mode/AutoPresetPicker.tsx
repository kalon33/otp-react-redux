import { useIntl } from 'react-intl'
import React from 'react'

import { AUTO_PRESETS } from '../../util/go-mode/auto-priority'
import type { AutoPreset } from '../../util/go-mode/auto-priority'

import { autoPresetHint, autoPresetLabel } from './auto-preset-copy'
import {
  AutoPresetRow,
  VehicleDetail,
  VehicleInfo,
  VehicleLabel
} from './styled'

/**
 * The four Auto presets as radio rows — the name and its rule in one line
 * (65.2; rider Q1 = C). Shared by the trip's preset sheet (B2) and the
 * "Start when I leave" arm card (B4), so both say the same thing the same
 * way. `selected` null: none checked (the sheet with Auto off).
 */
interface Props {
  /** The radio group's name; distinct per mounted picker. */
  name: string
  onPick: (preset: AutoPreset) => void
  selected: AutoPreset | null
}

export default function AutoPresetPicker({
  name,
  onPick,
  selected
}: Props): JSX.Element {
  const intl = useIntl()
  return (
    <div role="radiogroup">
      {AUTO_PRESETS.map((p) => (
        <AutoPresetRow
          $selected={p === selected}
          as="label"
          className="auto-preset-row"
          key={p}
        >
          <input
            checked={p === selected}
            name={name}
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
  )
}
