import {
  base64Bytes,
  buildFeedbackPayload,
  clearQueuedFeedback,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_QUEUE_KEY,
  FeedbackPayload,
  flushQueuedFeedback,
  isSendable,
  postFeedback,
  queueFeedback,
  readQueuedFeedback,
  scaledSize
} from '../../lib/util/feedback'

const ENDPOINT = 'https://example.test/api/ride-note'

/** A localStorage that cannot be affected by, or affect, another test. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    map,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => map.set(k, v)
  }
}

/** A fetch that answers with one canned body, and records what it was sent. */
function fakeFetch(body: unknown, { ok = true, status = 200 } = {}) {
  const calls: Array<{ body: any; url: string }> = []
  const impl = jest.fn(async (url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body), url })
    return { json: async () => body, ok, status } as Response
  })
  return { calls, impl: impl as unknown as typeof fetch }
}

describe('lib > util > feedback', () => {
  describe('scaledSize', () => {
    it('clamps the longest edge and keeps the aspect ratio', () => {
      // A 2026-era phone screenshot, portrait.
      expect(scaledSize(1290, 2796)).toEqual({ height: 1280, width: 591 })
      expect(scaledSize(4032, 3024)).toEqual({ height: 960, width: 1280 })
    })

    it('never upscales something already small', () => {
      expect(scaledSize(640, 480)).toEqual({ height: 480, width: 640 })
      expect(scaledSize(1280, 720)).toEqual({ height: 720, width: 1280 })
    })

    it('returns whole pixels, because a canvas dimension truncates', () => {
      const { height, width } = scaledSize(999, 1777)
      expect(Number.isInteger(width)).toBe(true)
      expect(Number.isInteger(height)).toBe(true)
    })

    it('treats a zero dimension as nothing to draw', () => {
      expect(scaledSize(0, 100)).toEqual({ height: 0, width: 0 })
    })
  })

  describe('base64Bytes', () => {
    it('measures a bare payload and a data URL identically', () => {
      // "hello world" is 11 bytes.
      const b64 = 'aGVsbG8gd29ybGQ='
      expect(base64Bytes(b64)).toEqual(11)
      expect(base64Bytes(`data:image/jpeg;base64,${b64}`)).toEqual(11)
    })

    it('is empty for an empty payload', () => {
      expect(base64Bytes('')).toEqual(0)
      expect(base64Bytes('data:image/jpeg;base64,')).toEqual(0)
    })
  })

  describe('buildFeedbackPayload', () => {
    it('is the ride-note shape plus the image', () => {
      expect(
        buildFeedbackPayload({
          deviceId: 'dev-1',
          image: 'data:image/jpeg;base64,AAA=',
          now: 1788552450000,
          sessionId: 'sess-1',
          text: 'white line at the top',
          tripId: 'trip:MT:12345'
        })
      ).toEqual({
        deviceId: 'dev-1',
        image: 'data:image/jpeg;base64,AAA=',
        sessionId: 'sess-1',
        source: 'feedback',
        text: 'white line at the top',
        tripId: 'trip:MT:12345',
        tsMs: 1788552450000
      })
    })

    it('omits what the client does not know rather than sending empties', () => {
      const payload = buildFeedbackPayload({ now: 1, text: 'just words' })
      expect(Object.keys(payload).sort()).toEqual(['source', 'text', 'tsMs'])
    })

    it('trims to the server cap so the rider sees the limit, not the loss', () => {
      const payload = buildFeedbackPayload({ text: 'x'.repeat(600) })
      expect(payload.text).toHaveLength(FEEDBACK_MAX_CHARS)
    })

    it('carries the tap time, so a report written in a tunnel keeps its moment', () => {
      expect(
        buildFeedbackPayload({ now: 1788552450000, text: 'a' }).tsMs
      ).toEqual(1788552450000)
    })
  })

  describe('isSendable', () => {
    it('accepts a screenshot with no caption', () => {
      expect(
        isSendable(
          buildFeedbackPayload({
            image: 'data:image/jpeg;base64,AA==',
            text: ''
          })
        )
      ).toBe(true)
    })

    it('rejects an empty report', () => {
      expect(isSendable(buildFeedbackPayload({ text: '   ' }))).toBe(false)
    })
  })

  describe('postFeedback', () => {
    it('POSTs JSON to the ride-note endpoint', async () => {
      const { calls, impl } = fakeFetch({ imageStored: true, ok: true })
      const payload = buildFeedbackPayload({ now: 5, text: 'note' })
      const result = await postFeedback(payload, ENDPOINT, impl)
      expect(result).toEqual({ error: undefined, imageStored: true, ok: true })
      expect(calls[0].url).toEqual(ENDPOINT)
      expect(calls[0].body).toEqual(payload)
    })

    it('reports a refused picture without calling the note a failure', async () => {
      // The server writes the note and refuses the attachment; the rider's
      // words reached the record, which is the point of the whole screen.
      const { impl } = fakeFetch({
        imageError: 'not an image',
        imageStored: false,
        ok: true
      })
      expect(
        await postFeedback(buildFeedbackPayload({ text: 'x' }), ENDPOINT, impl)
      ).toEqual({ error: 'not an image', imageStored: false, ok: true })
    })

    it('is a result, not a throw, when the server says no', async () => {
      const { impl } = fakeFetch({}, { ok: false, status: 429 })
      const result = await postFeedback(
        buildFeedbackPayload({ text: 'x' }),
        ENDPOINT,
        impl
      )
      expect(result.ok).toBe(false)
      expect(result.error).toEqual('http 429')
    })

    it('is a result, not a throw, when there is no network at all', async () => {
      const impl = jest.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
      const result = await postFeedback(
        buildFeedbackPayload({ text: 'x' }),
        ENDPOINT,
        impl
      )
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/offline/)
    })
  })

  describe('the offline hold', () => {
    it('round-trips a report through storage', () => {
      const store = fakeStorage()
      const payload = buildFeedbackPayload({
        image: 'data:image/jpeg;base64,AAA=',
        now: 7,
        text: 'held note'
      })
      expect(queueFeedback(payload, store)).toBe(true)
      expect(readQueuedFeedback(store)).toEqual(payload)
      clearQueuedFeedback(store)
      expect(readQueuedFeedback(store)).toBeNull()
    })

    it('drops the picture rather than the words when it is too big to hold', () => {
      // localStorage is a few megabytes for the whole app, shared with saved
      // places and the Go Mode session snapshot. A 1.2 MB base64 string that
      // already failed to send must not be what evicts a live trip.
      const store = fakeStorage()
      queueFeedback(
        buildFeedbackPayload({
          image: `data:image/jpeg;base64,${'A'.repeat(500000)}`,
          text: 'the words that matter'
        }),
        store
      )
      const held = readQueuedFeedback(store) as FeedbackPayload
      expect(held.text).toEqual('the words that matter')
      expect(held.image).toBeUndefined()
    })

    it('keeps one slot, not a backlog', () => {
      const store = fakeStorage()
      queueFeedback(buildFeedbackPayload({ text: 'first' }), store)
      queueFeedback(buildFeedbackPayload({ text: 'second' }), store)
      expect(store.map.size).toEqual(1)
      expect(readQueuedFeedback(store)?.text).toEqual('second')
    })

    it('treats an unreadable slot as nothing held', () => {
      expect(
        readQueuedFeedback(fakeStorage({ [FEEDBACK_QUEUE_KEY]: '{oops' }))
      ).toBeNull()
      expect(
        readQueuedFeedback(fakeStorage({ [FEEDBACK_QUEUE_KEY]: '{"a":1}' }))
      ).toBeNull()
    })

    it('survives a storage that refuses to be written', () => {
      const throwing = {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          throw new Error('QuotaExceeded')
        }
      }
      expect(queueFeedback(buildFeedbackPayload({ text: 'x' }), throwing)).toBe(
        false
      )
    })
  })

  describe('flushQueuedFeedback', () => {
    it('does nothing when nothing is held', async () => {
      const { calls, impl } = fakeFetch({ ok: true })
      expect(
        await flushQueuedFeedback(ENDPOINT, impl, fakeStorage())
      ).toBeNull()
      expect(calls).toHaveLength(0)
    })

    it('sends the held report and releases the slot', async () => {
      const store = fakeStorage()
      queueFeedback(buildFeedbackPayload({ now: 9, text: 'held' }), store)
      const { calls, impl } = fakeFetch({ imageStored: false, ok: true })
      const result = await flushQueuedFeedback(ENDPOINT, impl, store)
      expect(result?.ok).toBe(true)
      expect(calls[0].body.text).toEqual('held')
      expect(readQueuedFeedback(store)).toBeNull()
    })

    it('keeps the report when the retry fails too', async () => {
      // One attempt per visit, not one attempt ever: a retry that gave up for
      // good would be a second way to lose the rider's words.
      const store = fakeStorage()
      queueFeedback(buildFeedbackPayload({ text: 'still offline' }), store)
      const { impl } = fakeFetch({}, { ok: false, status: 502 })
      const result = await flushQueuedFeedback(ENDPOINT, impl, store)
      expect(result?.ok).toBe(false)
      expect(readQueuedFeedback(store)?.text).toEqual('still offline')
    })
  })
})
