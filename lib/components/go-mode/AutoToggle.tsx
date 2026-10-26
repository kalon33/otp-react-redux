import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
import type { AutoPreset } from '../../util/go-mode/auto-priority'

import { AutoChip } from './styled'
import { autoPresetLabel } from './auto-preset-copy'
import AutoPresetSheet from './AutoPresetSheet'

/**
 * The Auto chip over the map (65.2, cycle 36 B2; rider Q2 = A). Off at every
 * trip start, reading "Auto"; one tap turns it on with the preset last picked
 * on this device ("Auto · Fastest" on first use), and a tap while on opens the
 * preset sheet. Its own connected component, reading only `goMode.auto.on` and
 * `.preset`, so Go Mode's per-tick render never reaches it (66.10).
 */
interface Props {
  on: boolean
  preset: AutoPreset
  setAutoPreset: (preset: AutoPreset) => void
  turnAutoOff: () => void
  turnAutoOn: () => void
}

function AutoToggle({
  on,
  preset,
  setAutoPreset,
  turnAutoOff,
  turnAutoOn
}: Props): JSX.Element {
  const intl = useIntl()
  const [sheetOpen, setSheetOpen] = useState(false)
  const label = on
    ? intl.formatMessage(
        {
          defaultMessage: 'Auto · {preset}',
          id: 'components.GoMode.auto.chipOn'
        },
        { preset: autoPresetLabel(preset, intl) }
      )
    : intl.formatMessage({
        defaultMessage: 'Auto',
        id: 'components.GoMode.auto.chipOff'
      })
  return (
    <>
      <AutoChip
        $on={on}
        aria-pressed={on}
        className="auto-toggle"
        onClick={() => (on ? setSheetOpen(true) : turnAutoOn())}
        type="button"
      >
        {label}
      </AutoChip>
      {sheetOpen && (
        <AutoPresetSheet
          on={on}
          onClose={() => setSheetOpen(false)}
          onPick={(p) => {
            setAutoPreset(p)
            setSheetOpen(false)
          }}
          onTurnOff={() => {
            turnAutoOff()
            setSheetOpen(false)
          }}
          preset={preset}
        />
      )}
    </>
  )
}

const mapStateToProps = (state: any) => ({
  on: !!state.otp?.goMode?.auto?.on,
  preset: (state.otp?.goMode?.auto?.preset ?? 'fastest') as AutoPreset
})

const mapDispatchToProps = {
  setAutoPreset: goModeActions.setAutoPreset,
  turnAutoOff: goModeActions.turnAutoOff,
  turnAutoOn: goModeActions.turnAutoOn
}

export default connect(mapStateToProps, mapDispatchToProps)(AutoToggle)
