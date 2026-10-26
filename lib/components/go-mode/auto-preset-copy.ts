import type { IntlShape } from 'react-intl'

import type { AutoPreset } from '../../util/go-mode/auto-priority'

/** The preset's name, as the chip and the sheet say it (65.2). */
export function autoPresetLabel(preset: AutoPreset, intl: IntlShape): string {
  switch (preset) {
    case 'leastBike':
      return intl.formatMessage({
        defaultMessage: 'Least biking',
        id: 'components.GoMode.auto.preset.leastBike'
      })
    case 'simplest':
      return intl.formatMessage({
        defaultMessage: 'Simplest',
        id: 'components.GoMode.auto.preset.simplest'
      })
    case 'stayOnRoute':
      return intl.formatMessage({
        defaultMessage: 'Stay on my route',
        id: 'components.GoMode.auto.preset.stayOnRoute'
      })
    default:
      return intl.formatMessage({
        defaultMessage: 'Fastest',
        id: 'components.GoMode.auto.preset.fastest'
      })
  }
}

/** The preset's rule in one line, under its name in the sheet. */
export function autoPresetHint(preset: AutoPreset, intl: IntlShape): string {
  switch (preset) {
    case 'leastBike':
      return intl.formatMessage({
        defaultMessage: '1 km+ less biking, up to 2 min later',
        id: 'components.GoMode.auto.hint.leastBike'
      })
    case 'simplest':
      return intl.formatMessage({
        defaultMessage: 'Fewer transfers, up to 2 min later',
        id: 'components.GoMode.auto.hint.simplest'
      })
    case 'stayOnRoute':
      return intl.formatMessage({
        defaultMessage: 'Only earlier buses on your route',
        id: 'components.GoMode.auto.hint.stayOnRoute'
      })
    default:
      return intl.formatMessage({
        defaultMessage: '3+ min sooner, or 1 km+ less biking',
        id: 'components.GoMode.auto.hint.fastest'
      })
  }
}
