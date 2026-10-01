import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { act } from 'react-dom/test-utils'
import { ExclamationCircle } from '@styled-icons/fa-solid/ExclamationCircle'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import LocationField from '../../../lib/components/form/connected-location-field'

/**
 * Backlog 20.1 (address-search face), cycle 11. When the phone's path to the
 * API stalls, the Pelias fetch behind the address box never settles, and the
 * row under the field used to spin "Fetching suggestions…" forever. The
 * patched `@opentripplanner/location-field` gives each autocomplete request a
 * 10 s deadline and then says "Can't reach the server" in that same row, with
 * the exclamation icon the failed-search message already uses.
 *
 * The geocoder is mocked so each request's promise is under the test's
 * control; like `fetch`, a request rejects with an AbortError when its signal
 * is aborted.
 */
type Pending = {
  reject: (err: Error) => void
  resolve: (value: any) => void
  signal: AbortSignal
  text: string
}
const mockRequests: Pending[] = []
jest.mock('@opentripplanner/geocoder', () => ({
  __esModule: true,
  default: () => ({
    autocomplete: ({
      options,
      text
    }: {
      options: { signal: AbortSignal }
      text: string
    }) =>
      new Promise((resolve, reject) => {
        const signal = options.signal
        signal.addEventListener('abort', () => {
          const err = new Error('Fetch is aborted')
          err.name = 'AbortError'
          reject(err)
        })
        mockRequests.push({ reject, resolve, signal, text })
      })
  })
}))

/** Same flattening as location-picker.tsx: jest maps i18n/*.yml to {}. */
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
function loadYaml(relative: string) {
  return flatten(
    yaml.safeLoad(readFileSync(path.join(__dirname, relative), 'utf8'))
  )
}
// Merged the way lib/util/i18n-loader.js does it: the library's messages
// first, the app's own file on top.
const messages = {
  ...loadYaml(
    '../../../node_modules/@opentripplanner/location-field/i18n/en-US.yml'
  ),
  ...loadYaml('../../../i18n/en-US.yml')
}
const frMessages = loadYaml('../../../i18n/fr.yml')

const FEATURE = {
  geometry: { coordinates: [-93.2779, 44.9759], type: 'Point' },
  properties: {
    id: 'node/1',
    label: 'Nicollet Mall, Minneapolis',
    layer: 'street',
    name: 'Nicollet Mall',
    source: 'openstreetmap'
  },
  type: 'Feature'
}

function renderField() {
  const state = getMockInitialState()
  state.otp.location = {
    ...state.otp.location,
    // A non-empty nearby list keeps the field from firing its stopsByRadius
    // query on the first keystroke (see location-picker.tsx).
    nearbyStops: ['1:100']
  }
  state.otp.transitIndex = {
    ...(state.otp.transitIndex || {}),
    stops: {
      '1:100': {
        code: '17952',
        dist: 120,
        id: '1:100',
        lat: 44.977,
        lon: -93.272,
        name: 'Nicollet Ave & 5th St',
        routes: [{ shortName: '18' }]
      }
    }
  }
  return mockWithProvider(
    LocationField,
    { isStatic: true, locationType: 'to' },
    state,
    messages
  ).wrapper
}

function type(wrapper: any, value: string) {
  act(() => {
    wrapper
      .find('input[role="combobox"]')
      .simulate('change', { target: { value } })
  })
}

/** Advance fake time and let promise callbacks run. */
async function advance(wrapper: any, ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
  wrapper.update()
}

/** The status row the library unshifts above the options (key "abort-error"). */
function statusRow(wrapper: any) {
  return wrapper
    .find('Option')
    .filterWhere((node: any) => node.key() === 'abort-error')
}

describe('components > form > location field geocoder deadline (backlog 20.1)', () => {
  let consoleError: jest.SpyInstance
  beforeEach(() => {
    jest.useFakeTimers('modern')
    mockRequests.length = 0
    // The library logs every rejected request with console.error.
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleError.mockRestore()
    jest.useRealTimers()
  })

  it('has the rider-chosen copy in English and French', () => {
    expect(messages['otpUi.LocationField.geocoderTimeout']).toBe(
      "Can't reach the server"
    )
    expect(frMessages['otpUi.LocationField.geocoderTimeout']).toBe(
      'Impossible de joindre le serveur'
    )
  })

  it('replaces the endless spinner with "Can\'t reach the server" after 10 s', async () => {
    const wrapper = renderField()
    type(wrapper, '6610 Ox')
    await advance(wrapper, 300) // the library's debounce
    expect(mockRequests).toHaveLength(1)

    // While the request is out: the spinner row, as before.
    let row = statusRow(wrapper)
    expect(row).toHaveLength(1)
    expect(row.prop('title')).toBe('Fetching suggestions…')
    expect(row.prop('icon').type).not.toBe(ExclamationCircle)

    // Still waiting just short of the deadline.
    await advance(wrapper, 9999)
    expect(statusRow(wrapper).prop('title')).toBe('Fetching suggestions…')
    expect(mockRequests[0].signal.aborted).toBe(false)

    // At 10 s: the line, with the exclamation icon, and no spinner anywhere.
    await advance(wrapper, 1)
    row = statusRow(wrapper)
    expect(row).toHaveLength(1)
    expect(row.prop('title')).toBe("Can't reach the server")
    expect(row.prop('icon').type).toBe(ExclamationCircle)
    expect(wrapper.text()).not.toContain('Fetching suggestions')
    expect(wrapper.text()).toContain("Can't reach the server")
    // The stalled request itself is cancelled, and its AbortError does not
    // overwrite the line with the library's "Unable to obtain suggestions".
    expect(mockRequests[0].signal.aborted).toBe(true)
    await advance(wrapper, 20000)
    expect(statusRow(wrapper).prop('title')).toBe("Can't reach the server")
    expect(wrapper.text()).not.toContain('Unable to obtain suggestions')
  })

  it("keeps a keystroke's own abort silent", async () => {
    const wrapper = renderField()
    type(wrapper, '6610')
    await advance(wrapper, 300)
    expect(mockRequests).toHaveLength(1)

    // The next keystroke aborts the first request.
    type(wrapper, '6610 Ox')
    await advance(wrapper, 0)
    expect(mockRequests[0].signal.aborted).toBe(true)
    expect(statusRow(wrapper)).toHaveLength(0)
    expect(wrapper.text()).not.toContain("Can't reach the server")
    expect(wrapper.text()).not.toContain('Unable to obtain suggestions')

    // The second request starts after the debounce and answers in time; the
    // first request's deadline (10 s after it started) must not fire a line.
    await advance(wrapper, 300)
    expect(mockRequests).toHaveLength(2)
    await act(async () => {
      mockRequests[1].resolve({ features: [FEATURE] })
    })
    await advance(wrapper, 20000)
    expect(statusRow(wrapper)).toHaveLength(0)
    expect(wrapper.text()).not.toContain("Can't reach the server")
    expect(wrapper.text()).toContain('Nicollet Mall')
  })

  it('still shows suggestions when the geocoder answers', async () => {
    const wrapper = renderField()
    type(wrapper, 'Nicollet')
    await advance(wrapper, 300)
    expect(mockRequests).toHaveLength(1)
    await advance(wrapper, 800) // a healthy Pelias answers in 0.22–0.95 s
    await act(async () => {
      mockRequests[0].resolve({ features: [FEATURE] })
    })
    wrapper.update()
    expect(wrapper.text()).toContain('Nicollet Mall')
    expect(statusRow(wrapper)).toHaveLength(0)
    expect(wrapper.text()).not.toContain('Fetching suggestions')

    // Past the deadline nothing changes: the answered request's timer is gone.
    await advance(wrapper, 20000)
    expect(wrapper.text()).toContain('Nicollet Mall')
    expect(statusRow(wrapper)).toHaveLength(0)
    expect(mockRequests[0].signal.aborted).toBe(false)
  })

  it('clears the spinner when the request fails outright', async () => {
    const wrapper = renderField()
    type(wrapper, 'Nicollet')
    await advance(wrapper, 300)
    await act(async () => {
      mockRequests[0].reject(new TypeError('Load failed'))
    })
    wrapper.update()
    const row = statusRow(wrapper)
    expect(row).toHaveLength(1)
    expect(row.prop('title')).toContain('Unable to obtain suggestions')
    // The library never cleared isFetching here, so this row kept its spinner.
    expect(row.prop('icon').type).toBe(ExclamationCircle)
  })
})
