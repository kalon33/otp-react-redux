import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'

import { FEEDBACK_QUEUE_KEY } from '../../../lib/util/feedback'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { setDefaultTestTime } from '../../test-utils'
import FeedbackScreen from '../../../lib/components/user/feedback-screen'

// AppFrame pulls in DesktopNav -> AppMenu, whose constructor calls into the
// debug-log module; under jest that module resolves to a stub without these
// functions, and the mount throws before any of this screen renders. Same stub
// as __tests__/components/user/settings-screen.tsx, plus the two identity
// readers and the recorder this screen uses.
const recorded: Array<Record<string, unknown>> = []
jest.mock('../../../lib/util/debug-log', () => ({
  currentSessionId: () => 'sess-test',
  getBuildInfo: () => 'test',
  getDeviceId: () => 'dev-test',
  isDebugLogEnabled: () => false,
  logDebugAction: () => undefined,
  recordSessionEvent: (event: string, fields: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).__feedbackEvents.push({ event, ...fields }),
  setDebugLogEnabled: () => undefined
}))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).__feedbackEvents = recorded

// jsdom has no 2d context, so the canvas re-encode cannot run here. Everything
// else in the module — sendFeedback, the queue, the 413 retry — is the real
// thing, because that is what is under test.
jest.mock('../../../lib/util/feedback', () => ({
  ...jest.requireActual('../../../lib/util/feedback'),
  downscaleImage: async () => 'data:image/jpeg;base64,AAAA'
}))

/** The one place this file reaches for the global, so the casts stay in it. */
function setFetch(impl: typeof fetch): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = global as any
  scope.fetch = impl
}

/** A fetch that answers each call from a script and records what it was sent. */
function scriptFetch(
  script: Array<{ body?: unknown; ok?: boolean; status?: number }>
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl = jest.fn(async (url: string, init: any) => {
    const step = script[Math.min(calls.length, script.length - 1)]
    calls.push(JSON.parse(init.body))
    return {
      json: async () => step.body ?? {},
      ok: step.ok ?? true,
      status: step.status ?? 200
    }
  })
  setFetch(impl as unknown as typeof fetch)
  return calls
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderScreen(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = getMockInitialState()
  state.router = { location: { pathname: '/feedback', search: '' } }
  return mockWithProvider(FeedbackScreen, {}, state)
}

/** Pick a screenshot, the way the rider's IMG_3490.png arrived. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attach(wrapper: any) {
  wrapper.find('input[type="file"]').simulate('change', {
    target: { files: [{ name: 'IMG_3490.png', type: 'image/png' }] }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function type(wrapper: any, value: string) {
  wrapper.find('textarea').simulate('change', { target: { value } })
}

/**
 * Let every pending POST and its `.then` run. `onSend` awaits a flush of the
 * whole hold and then the send itself, each of which awaits fetch and res.json,
 * so a handful of microtasks is not enough — drain the macrotask queue instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function settle(wrapper: any) {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  wrapper.update()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(wrapper: any) {
  wrapper.find('button.btn-primary').first().simulate('click')
  await settle(wrapper)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const statusText = (wrapper: any) =>
  wrapper.find('.feedback-status').first().text()

const queued = () =>
  JSON.parse(window.localStorage.getItem(FEEDBACK_QUEUE_KEY) || '[]')

/**
 * The rider-reported defect of 2026-09-06: a report with a full-resolution
 * iPhone screenshot answered "Saved. It will send the next time you open this
 * screen." and never sent, while an EARLIER held report said the same thing
 * and had already been stuck for a day. Both of the causes were server-side
 * refusals this screen could not distinguish (see the header of
 * feedback-screen.tsx); what it CAN do is say which one happened and not throw
 * anything away.
 */
describe('components > user > feedback screen (the 2026-09-06 silent hold)', () => {
  beforeEach(() => {
    setDefaultTestTime()
    window.localStorage.clear()
    recorded.length = 0
  })

  it('names the 403 the phone gets off the tailnet instead of promising delivery', async () => {
    scriptFetch([{ ok: false, status: 403 }])
    const { wrapper } = renderScreen()
    type(wrapper, 'the send button did nothing')
    await send(wrapper)
    // The old copy here was "Saved. It will send the next time you open this
    // screen." — false, because /api/ride-note is `deny all` off the tailnet
    // and the identical request is refused on every visit.
    expect(statusText(wrapper)).toMatch(/refused this report \(403\)/)
    expect(statusText(wrapper)).not.toMatch(/next time you open this screen/)
    expect(queued()[0].text).toEqual('the send button did nothing')
  })

  it('still promises a retry when a retry could actually work', async () => {
    scriptFetch([{ ok: false, status: 503 }])
    const { wrapper } = renderScreen()
    type(wrapper, 'server hiccup')
    await send(wrapper)
    expect(statusText(wrapper)).toMatch(/could not take it \(503\)/)
    expect(statusText(wrapper)).toMatch(/next time you open this screen/)
  })

  it('says the connection is down, not that the server refused it', async () => {
    // WebKit's message for a fetch that never reached the network at all.
    setFetch(
      jest.fn(async () => {
        throw new Error('Load failed')
      }) as unknown as typeof fetch
    )
    const { wrapper } = renderScreen()
    type(wrapper, 'in a tunnel')
    await send(wrapper)
    expect(statusText(wrapper)).toMatch(/No connection/)
  })

  it('does not destroy a held report when a later one succeeds', async () => {
    // The line this replaces was `clearQueuedFeedback()` on success, reasoning
    // that "whatever was being held is either this or older". It is neither: it
    // is a different report with a different screenshot.
    window.localStorage.setItem(
      FEEDBACK_QUEUE_KEY,
      JSON.stringify({
        source: 'feedback',
        text: 'the 9.4 white border',
        tsMs: 1
      })
    )
    // Mount flush fails (403), then the new report is sent — and the flush
    // inside onSend fails again before it.
    const calls = scriptFetch([
      { ok: false, status: 403 },
      { ok: false, status: 403 },
      { body: { ok: true } }
    ])
    const { wrapper } = renderScreen()
    await settle(wrapper)
    type(wrapper, 'and now this one')
    await send(wrapper)
    expect(calls.map((c) => c.text)).toEqual([
      'the 9.4 white border',
      'the 9.4 white border',
      'and now this one'
    ])
    expect(queued().map((p: { text: string }) => p.text)).toEqual([
      'the 9.4 white border'
    ])
    expect(statusText(wrapper)).toMatch(/still waiting/)
  })

  it('sends the words alone when the route 413s the screenshot, and says so', async () => {
    // End to end through the real sendFeedback: nginx refuses the body for its
    // size, the picture is dropped, and the sentence still reaches riderNotes.
    const calls = scriptFetch([
      { ok: false, status: 413 },
      { body: { imageStored: false, ok: true } }
    ])
    const { wrapper } = renderScreen()
    type(wrapper, 'white line along the top border')
    attach(wrapper)
    await settle(wrapper)
    await send(wrapper)
    expect(calls).toHaveLength(2)
    expect(calls[0].image).toBeDefined()
    expect(calls[1].image).toBeUndefined()
    expect(calls[1].text).toEqual('white line along the top border')
    // Not "Sent. Thank you." — the evidence did not arrive and the rider is the
    // only person who can send it again.
    expect(statusText(wrapper)).toMatch(/picture could not be attached/)
  })

  it('records the outcome, so the next failure is visible in the debug log', async () => {
    // It was not: the 2026-09-06 log carries 789 events from that session and
    // no trace of the POST at all, because postFeedback swallows every error.
    scriptFetch([{ ok: false, status: 413 }])
    const { wrapper } = renderScreen()
    type(wrapper, 'anything')
    await send(wrapper)
    const sent = recorded.find((e) => e.event === 'feedback-send')
    expect(sent).toMatchObject({
      failure: 'too-large',
      ok: false,
      status: 413
    })
  })
})

/**
 * Rider note 2026-09-08 15:30:38, with a screenshot of this screen:
 * *"Weird format for selecting multiple photos"*
 * (`~/otp-debug-logs/feedback/mtt4i5o2-gy56xv-1788899438491.jpg`).
 *
 * What the picture shows is one attachment rendered THREE times: WKWebView's
 * bare "Choose File" pill, then its own preview of the pick (a broken-image
 * glyph plus "IMG_3503.png"), then our 160 px thumbnail, with a "Remove"
 * button floating at the thumbnail's vertical middle and nothing tying the two
 * together. "Multiple photos" is the other half of the note: there is no
 * `multiple` on the input and there cannot be — `/api/ride-note` decodes a
 * single `image` string per POST, and one 900,000-byte picture is already
 * ~1.2 MB of base64 against the route's 1536k body cap.
 */
describe('components > user > feedback screen (2026-09-08 picker)', () => {
  beforeEach(() => {
    setDefaultTestTime()
    window.localStorage.clear()
    recorded.length = 0
  })

  it('offers one picture, and says so, rather than a multi-select it would drop', () => {
    const { wrapper } = renderScreen()
    const input = wrapper.find('input[type="file"]')
    // The server takes one `image` per POST. A `multiple` picker would let the
    // rider choose four and silently send the first.
    expect(input.prop('multiple')).toBeFalsy()
    expect(wrapper.text()).toContain('One screenshot per report')
  })

  it('keeps the real input in the DOM but out of the rider’s way', () => {
    const { wrapper } = renderScreen()
    const input = wrapper.find('input[type="file"]')
    // It still has to exist: it is the only control that reaches the camera
    // roll and the screenshot album on iOS and Android without a plugin.
    expect(input).toHaveLength(1)
    expect(input.prop('accept')).toBe('image/*')
    // But it is not what the rider looks at, so WKWebView cannot paint its
    // "Choose File" pill and its broken-image filename preview over our own.
    expect(input.prop('aria-hidden')).toBe(true)
    expect(input.prop('tabIndex')).toBe(-1)
  })

  it('opens the picker from our own button', () => {
    const { wrapper } = renderScreen()
    const node = wrapper
      .find('input[type="file"]')
      .getDOMNode() as HTMLInputElement
    const click = jest.spyOn(node, 'click')
    const button = wrapper
      .find('button')
      .filterWhere((b: { text: () => string }) =>
        /Add a screenshot/.test(b.text())
      )
    expect(button).toHaveLength(1)
    button.simulate('click')
    expect(click).toHaveBeenCalled()
  })

  it('renders an attachment exactly once, with its own remove control', async () => {
    const { wrapper } = renderScreen()
    expect(wrapper.find('img')).toHaveLength(0)
    attach(wrapper)
    // downscaleImage is a promise even in the mock, so the tile appears a
    // microtask after the pick.
    await settle(wrapper)

    // One thumbnail — not a filename row above it and a second preview below.
    expect(wrapper.find('img')).toHaveLength(1)
    const remove = wrapper.find('button[aria-label="Remove the screenshot"]')
    expect(remove).toHaveLength(1)
    // The button offers the honest next action once a picture is attached.
    expect(wrapper.text()).toContain('Replace screenshot')
    expect(wrapper.text()).not.toContain('Add a screenshot')

    remove.simulate('click')
    wrapper.update()
    expect(wrapper.find('img')).toHaveLength(0)
    expect(wrapper.text()).toContain('Add a screenshot')
  })

  it('still sends the picked screenshot with the report', async () => {
    const calls = scriptFetch([{ body: { imageStored: true, ok: true } }])
    const { wrapper } = renderScreen()
    type(wrapper, 'Mixing biking and walking routes here')
    attach(wrapper)
    await settle(wrapper)
    await send(wrapper)
    expect(calls).toHaveLength(1)
    expect(calls[0].image).toBe('data:image/jpeg;base64,AAAA')
    expect(calls[0].text).toBe('Mixing biking and walking routes here')
    // Sent clears the tile, so the next report does not re-attach this one.
    expect(wrapper.find('img')).toHaveLength(0)
  })
})
