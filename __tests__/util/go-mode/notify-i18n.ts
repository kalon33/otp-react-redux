import fs from 'fs'
import path from 'path'

import flatten from 'flat'
import yaml from 'js-yaml'

import {
  checkDestinationUnreachable,
  checkLegTransition,
  checkTripComplete,
  resetLegAnnouncements
} from '../../../lib/util/go-mode/notification-service'
import { evaluateDepartureDrift } from '../../../lib/util/go-mode/departure-drift'
import {
  notifyIntl,
  resetNotifyLocale,
  setNotifyLocale
} from '../../../lib/util/go-mode/notify-i18n'

/**
 * Backlog 12.23: the Go Mode alert copy used to be English literals with no key
 * in either message file, so a French rider got English on the lock screen and
 * the wrist. `check:i18n-en-fr` is the acceptance test for the KEYS; this is
 * the test for the MECHANISM — that the key actually resolves through the
 * locale the app registered, all the way out to the notification object the
 * push path sends.
 *
 * The catalogues are read off disk rather than hand-written, so a French string
 * that is missing or malformed fails here and not only on a rider's phone.
 * (Jest maps `i18n/*.yml` imports to an empty stub, hence the fs read.)
 */
const catalogue = (locale: string): Record<string, string> =>
  flatten(
    yaml.load(
      fs.readFileSync(
        path.join(__dirname, `../../../i18n/${locale}.yml`),
        'utf8'
      )
    ) as Record<string, unknown>
  )

const PROGRESS = {
  distanceToDestination: 5,
  overallProgress: 99.9,
  status: 'completed'
} as any

afterEach(resetNotifyLocale)

describe('util > go-mode > notification copy is localized', () => {
  it('falls back to the English defaults with no locale registered', () => {
    const done = checkTripComplete(PROGRESS, [])
    expect(done).toMatchObject({ message: 'Arrived', title: 'Trip complete' })
  })

  it('renders the registered locale, not English', () => {
    setNotifyLocale('fr', catalogue('fr'))
    const done = checkTripComplete(PROGRESS, [])
    expect(done).toMatchObject({
      message: 'Arrivé',
      title: 'Trajet terminé'
    })
  })

  it('renders en-US exactly as the literals did', () => {
    setNotifyLocale('en-US', catalogue('en-US'))
    expect(checkTripComplete(PROGRESS, [])).toMatchObject({
      message: 'Arrived',
      title: 'Trip complete'
    })
    expect(checkDestinationUnreachable([], 420, 'Target')).toMatchObject({
      message: '420m from Target · not getting closer',
      title: 'Routing stops here'
    })
    expect(checkDestinationUnreachable([], null)).toMatchObject({
      message: 'some way · not getting closer'
    })
  })

  it('carries the interpolated values through a translation', () => {
    setNotifyLocale('fr', catalogue('fr'))
    const alert = checkDestinationUnreachable([], 420, 'Cible')
    expect(alert?.message).toBe('420 m de Cible · sans se rapprocher')
    expect(alert?.title).toBe('Itinéraire interrompu')
  })

  it('localizes departure-drift copy too', () => {
    const T0 = 1_700_000_000_000
    const baseline = {
      baselineMs: T0 + 20 * 60_000,
      boardingKey: '1:trip:plan',
      lastAlertedDriftMs: 0
    }
    const input = {
      boardingKey: '1:trip:plan',
      liveDepartureMs: T0 + 26 * 60_000,
      nowMs: T0,
      routeName: '22',
      waitSeconds: 600
    }
    setNotifyLocale('en-US', catalogue('en-US'))
    expect(evaluateDepartureDrift(baseline, input).alert).toMatchObject({
      message: '6 min later · 10 min slack',
      title: '22 · 26 min'
    })
    setNotifyLocale('fr', catalogue('fr'))
    expect(evaluateDepartureDrift(baseline, input).alert).toMatchObject({
      message: '6 min plus tard · 10 min de marge',
      title: '22 · 26 min'
    })
  })

  it('has a French string for every notify key in en-US', () => {
    const en = catalogue('en-US')
    const fr = catalogue('fr')
    const keys = Object.keys(en).filter((k) =>
      k.startsWith('components.GoMode.notify.')
    )
    expect(keys.length).toBeGreaterThan(50)
    expect(keys.filter((k) => !fr[k])).toEqual([])
    // A "translation" that is byte-identical to the English is the bug this row
    // is about, so at least the words (not the {placeholder} skeletons) differ.
    const wordy = keys.filter((k) =>
      /[A-Za-z]{4}/.test(en[k].replace(/\{\w+\}/g, ''))
    )
    expect(wordy.filter((k) => fr[k] === en[k])).toEqual([])
  })

  /**
   * Backlog 17.27, both halves, in the one builder they share.
   *
   * (a) The title was 'Next Step' — the only Title Case title among the twelve
   * this file raises ('Next stop', 'Your stop', 'Bus here', 'Bus coming',
   * 'Missed bus', 'Off route', 'Routing stops here', 'Connection at risk',
   * 'Tight connection', 'Running late', 'Trip complete').
   *
   * (b) `routeShortName` and `routeLongName` are BOTH optional on a Leg and
   * this branch is entered on the mode alone, so an unnamed route rendered
   * 'Board undefined to X' before 12.23 and 'Board  to X' (two spaces) after
   * it. Every other builder in the file has a named fallback; this one now
   * does too, and it is mode-neutral because RAIL reaches the same branch.
   */
  describe('the leg-transition alert (17.27)', () => {
    afterEach(resetLegAnnouncements)

    const namedLeg = () =>
      ({
        mode: 'BUS',
        routeShortName: '21',
        to: { name: 'Uptown Transit Station' }
      } as any)
    const namelessRail = () =>
      ({ mode: 'RAIL', to: { name: 'Stadium Village' } } as any)

    it('titles in sentence case, like its eleven siblings', () => {
      setNotifyLocale('en-US', catalogue('en-US'))
      expect(checkLegTransition(1, 0, namedLeg(), [])).toMatchObject({
        message: 'Board 21 to Uptown Transit Station',
        title: 'Next step'
      })
    })

    it('never renders an empty route name', () => {
      setNotifyLocale('en-US', catalogue('en-US'))
      const alert = checkLegTransition(1, 0, namelessRail(), [])
      expect(alert?.message).toBe('Board your ride to Stadium Village')
      expect(alert?.message).not.toContain('  ')
      expect(alert?.message).not.toContain('undefined')
    })

    it('translates both the title and the nameless fallback', () => {
      setNotifyLocale('fr', catalogue('fr'))
      const alert = checkLegTransition(1, 0, namelessRail(), [])
      expect(alert?.title).toBe('\u00c9tape suivante')
      expect(alert?.message).toBe(
        'Monter dans votre v\u00e9hicule vers Stadium Village'
      )
    })
  })

  it('resolves through one handle, so a locale change is seen everywhere', () => {
    setNotifyLocale('fr', catalogue('fr'))
    const first = notifyIntl()
    setNotifyLocale('en-US', catalogue('en-US'))
    expect(notifyIntl()).not.toBe(first)
    expect(notifyIntl().locale).toBe('en-US')
  })
})
