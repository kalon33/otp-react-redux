import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import { mockWithProvider } from '../../test-utils/mock-data/store'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

/**
 * Backlog 44.3. Rider note `c-1791500672495`, 2026-10-08 18:04:32: "visual
 * directions instead of words on the bike routing". Q2 answered "Both"; this
 * suite is the card's half — a big arrow beside the turn, drawn from the
 * cue's own `relativeDirection` (h8y7qw 08:00:12 carried `SLIGHTLY_RIGHT`,
 * "Bear right on Village Terrace"). Before this the turn was a text line only.
 */
const NOW = 1_791_500_000_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bikeLeg: any = {
  distance: 1200,
  duration: 300,
  from: { name: 'Home' },
  mode: 'BICYCLE',
  to: { name: '3020 Girard Ave S' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const busLeg: any = {
  from: { name: 'Lake St & Hennepin Ave', stop: { gtfsId: '1:1001' } },
  mode: 'BUS',
  routeShortName: '21'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cue = (relativeDirection: string, instruction: string): any => ({
  distanceMeters: 150,
  index: 1,
  instruction,
  lat: 44.948,
  lon: -93.29,
  offsetMeters: 400,
  relativeDirection,
  significant: true,
  streetName: 'Girard Ave S'
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progress = (over: any = {}): any => ({
  currentLegIndex: 0,
  currentLegProgress: 40,
  currentTime: new Date(NOW),
  estimatedArrival: new Date(NOW + 300000),
  overallProgress: 40,
  plannedDepartureTime: NOW + 10 * 60000,
  status: 'on_track',
  timeRemaining: 300,
  ...over
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (props: any) =>
  mockWithProvider(
    WalkingNavigation,
    { leg: bikeLeg, ...props },
    undefined,
    messages
  ).wrapper

const arrowOf = (wrapper: ReturnType<typeof render>) =>
  wrapper.find('[data-testid="go-mode-turn-arrow"]').hostNodes()

describe('components > go-mode > the turn arrow on the card (44.3)', () => {
  const cases: [string, string][] = [
    ['LEFT', 'Turn left on Girard Ave S'],
    ['RIGHT', 'Turn right on Girard Ave S'],
    ['SLIGHTLY_LEFT', 'Bear left on Girard Ave S'],
    ['SLIGHTLY_RIGHT', 'Bear right on Village Terrace'],
    ['HARD_LEFT', 'Sharp left on Girard Ave S'],
    ['HARD_RIGHT', 'Sharp right on Girard Ave S'],
    ['UTURN_LEFT', 'U-turn on Girard Ave S'],
    ['UTURN_RIGHT', 'U-turn on Girard Ave S'],
    ['CIRCLE_CLOCKWISE', 'Take the roundabout']
  ]

  it.each(cases)(
    'draws the %s arrow beside the words on a bike-only card',
    (direction, instruction) => {
      // FAILS BEFORE: no arrow element existed; the turn was a text line.
      const wrapper = render({
        progress: progress({
          distanceToNextTurn: 120,
          nextInstruction: instruction,
          nextTurnCue: cue(direction, instruction)
        })
      })
      const arrow = arrowOf(wrapper)
      expect(arrow).toHaveLength(1)
      expect(arrow.prop('data-direction')).toBe(direction)
      expect(arrow.prop('aria-hidden')).toBe(true)
      // A real picture, not an empty box.
      expect(arrow.find('svg').hostNodes()).toHaveLength(1)
      // The words stay, beside it.
      expect(wrapper.text()).toContain(instruction)
    }
  )

  it('draws the arrow beside the turn on a bike-to-bus card too', () => {
    const wrapper = render({
      nextLeg: busLeg,
      progress: progress({
        distanceToNextTurn: 320,
        nextInstruction: 'Turn right on E Lake Nokomis Pkwy',
        nextTurnCue: cue('RIGHT', 'Turn right on E Lake Nokomis Pkwy')
      })
    })
    const arrow = arrowOf(wrapper)
    expect(arrow).toHaveLength(1)
    expect(arrow.prop('data-direction')).toBe('RIGHT')
    expect(wrapper.text()).toContain('Turn right on E Lake Nokomis Pkwy')
  })

  it('shows a straight arrow on the "Continue to" line (no turn left)', () => {
    const wrapper = render({
      progress: progress({
        currentLegProgress: 60,
        distanceToNextTurn: 400,
        nextInstruction: 'Continue to 3020 Girard Ave S'
      })
    })
    expect(arrowOf(wrapper).prop('data-direction')).toBe('CONTINUE')
  })

  it('shows a destination pin on the "Arriving at" line', () => {
    const wrapper = render({
      progress: progress({
        currentLegProgress: 95,
        distanceToNextTurn: 40,
        nextInstruction: 'Arriving at 3020 Girard Ave S'
      })
    })
    expect(arrowOf(wrapper).prop('data-direction')).toBe('ARRIVE')
    expect(wrapper.text()).toContain('Arriving at 3020 Girard Ave S')
  })

  it('draws no arrow once the trip has arrived (13.5)', () => {
    const wrapper = render({
      arrived: true,
      progress: progress({
        distanceToNextTurn: 12,
        nextInstruction: 'Turn right on alley',
        nextTurnCue: cue('RIGHT', 'Turn right on alley')
      })
    })
    expect(arrowOf(wrapper)).toHaveLength(0)
  })

  it('draws no arrow when there is no instruction at all (off route)', () => {
    const wrapper = render({ progress: progress({}) })
    expect(arrowOf(wrapper)).toHaveLength(0)
  })

  it('keeps the words and draws no empty box for a direction it has no arrow for', () => {
    const wrapper = render({
      progress: progress({
        distanceToNextTurn: 50,
        nextInstruction: 'Continue',
        nextTurnCue: cue('SOMETHING_NEW', 'Continue')
      })
    })
    expect(arrowOf(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('Continue')
  })
})
