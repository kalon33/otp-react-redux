import { createIntl, createIntlCache } from 'react-intl'

import { formatDistance, formatSpeed } from '../../lib/util/units'

const cache = createIntlCache()
const fr = createIntl({ locale: 'fr-FR' }, cache)
const en = createIntl({ locale: 'en-US' }, cache)

describe('util > units', () => {
  it('formats speeds in km/h for a metric rider', () => {
    // 5 m/s is the server's bike speed: 18 km/h.
    expect(formatSpeed(fr, 5, 'metric')).toMatch(/18[\u202f ]km\/h/)
  })

  it('formats speeds in mph for an imperial rider', () => {
    expect(formatSpeed(en, 5, 'imperial')).toMatch('11.2 mph')
  })

  it('localises the decimal separator with the locale', () => {
    // 2.5 m/s is 9 km/h; 2.15 m/s is 7.74 → French "7,7 km/h".
    expect(formatSpeed(fr, 2.15, 'metric')).toMatch(',')
    expect(formatSpeed(fr, 2.15, 'metric')).toMatch(/7,7[\u202f ]km\/h/)
  })

  it('formats the bike ceiling distance in both systems', () => {
    // 120 minutes at 5 m/s is 36 km / 22.37 mi.
    expect(formatDistance(fr, 36000, 'metric')).toMatch(/36[\u202f ]km/)
    expect(formatDistance(en, 36000, 'imperial')).toMatch(/22[\u202f ]mi/)
  })

  it('defaults to imperial when no unit system is given', () => {
    expect(formatSpeed(en, 5)).toMatch('mph')
  })
})
