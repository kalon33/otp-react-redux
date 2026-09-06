import {
  base64Bytes,
  buildFeedbackPayload,
  classifyStatus,
  clearQueuedFeedback,
  encodeWithinBudget,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_QUEUE_KEY,
  FEEDBACK_QUEUE_MAX_ITEMS,
  flushQueuedFeedback,
  isRetryable,
  isSendable,
  postFeedback,
  queuedFeedbackCount,
  queueFeedback,
  readFeedbackQueue,
  readQueuedFeedback,
  scaledSize,
  sendFeedback,
  withoutImage
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

/**
 * A fetch that answers each call from a script, so the 413-then-retry path and
 * a multi-item flush can both be asserted on.
 */
function scriptedFetch(
  script: Array<{ body?: unknown; ok?: boolean; status?: number }>
) {
  const calls: Array<{ body: any; url: string }> = []
  const impl = jest.fn(async (url: string, init: any) => {
    const step = script[Math.min(calls.length, script.length - 1)]
    calls.push({ body: JSON.parse(init.body), url })
    return {
      json: async () => step.body ?? {},
      ok: step.ok ?? true,
      status: step.status ?? 200
    } as Response
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
      expect(result).toEqual({
        error: undefined,
        imageDropped: false,
        imageStored: true,
        ok: true,
        status: 200
      })
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
      ).toEqual({
        error: 'not an image',
        imageDropped: false,
        imageStored: false,
        ok: true,
        status: 200
      })
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

  describe('classifying what went wrong', () => {
    // The two that actually fired on 2026-09-06. Both are deterministic, and
    // both used to be reported as "Saved. It will send the next time you open
    // this screen." while the report sat there for two days.
    it('names the 413 from `client_max_body_size 4k` on /api/ride-note', () => {
      expect(classifyStatus(413)).toEqual('too-large')
      expect(isRetryable('too-large')).toBe(false)
    })

    it("names the 403 from the route's tailnet-only ACL", () => {
      expect(classifyStatus(403)).toEqual('not-allowed')
      expect(classifyStatus(401)).toEqual('not-allowed')
      expect(isRetryable('not-allowed')).toBe(false)
    })

    it('keeps promising a retry only where a retry could work', () => {
      expect(classifyStatus(429)).toEqual('rate-limited')
      expect(classifyStatus(502)).toEqual('server')
      expect(isRetryable('network')).toBe(true)
      expect(isRetryable('rate-limited')).toBe(true)
      expect(isRetryable('server')).toBe(true)
    })
  })

  describe('encodeWithinBudget', () => {
    // jsdom has no 2d context, which is why the ladder is a pure function the
    // canvas feeds rather than a loop buried inside downscaleImage.
    const url = (bytes: number) =>
      `data:image/jpeg;base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`

    it('stops at the first rung that fits', () => {
      const tried: number[] = []
      const out = encodeWithinBudget(
        ({ maxEdge }) => {
          tried.push(maxEdge)
          return url(maxEdge === 1280 ? 1200 : 500)
        },
        [
          { maxEdge: 1280, quality: 0.8 },
          { maxEdge: 1024, quality: 0.7 },
          { maxEdge: 800, quality: 0.6 }
        ],
        1000
      )
      expect(tried).toEqual([1280, 1024])
      expect(base64Bytes(out as string)).toBeLessThanOrEqual(1000)
    })

    it('re-encodes rather than throwing the picture away, which is what the single rung did', () => {
      // A detailed 12 MP frame at 1280/0.8 clears the budget; before the ladder
      // the rider just got "That file could not be attached." and lost the only
      // evidence a UI defect has.
      const out = encodeWithinBudget(
        ({ maxEdge }) => url(maxEdge * 2),
        undefined,
        1700
      )
      expect(out).not.toBeNull()
    })

    it('gives up only when no rung fits', () => {
      expect(encodeWithinBudget(() => url(9e6), undefined, 1000)).toBeNull()
    })

    it('skips a rung the encoder could not produce', () => {
      const out = encodeWithinBudget(
        ({ maxEdge }) => (maxEdge === 1280 ? null : url(10)),
        undefined,
        1000
      )
      expect(out).not.toBeNull()
    })
  })

  describe('sendFeedback and the 413', () => {
    it('sends the words alone when the route refuses the body for its size', async () => {
      // The 2026-09-06 defect: `location /api/ride-note` carries
      // client_max_body_size 4k, so ANY screenshot is 413'd at nginx and never
      // reaches Flask. The sentence still has to reach `riderNotes`.
      const { calls, impl } = scriptedFetch([
        { ok: false, status: 413 },
        { body: { imageStored: false, ok: true } }
      ])
      const payload = buildFeedbackPayload({
        image: 'data:image/jpeg;base64,AAAA',
        text: 'white line along the top border'
      })
      const result = await sendFeedback(payload, ENDPOINT, impl)
      expect(result.ok).toBe(true)
      expect(result.imageDropped).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].body.image).toBeDefined()
      expect(calls[1].body.image).toBeUndefined()
      expect(calls[1].body.text).toEqual('white line along the top border')
    })

    it('does not retry a 403, which is not about the bytes', async () => {
      // Off the tailnet the route is `deny all`. Re-sending without the picture
      // fails identically and only costs another request.
      const { calls, impl } = scriptedFetch([{ ok: false, status: 403 }])
      const result = await sendFeedback(
        buildFeedbackPayload({
          image: 'data:image/jpeg;base64,AA==',
          text: 'x'
        }),
        ENDPOINT,
        impl
      )
      expect(result.failure).toEqual('not-allowed')
      expect(result.imageDropped).toBe(false)
      expect(calls).toHaveLength(1)
    })

    it('does not retry a 413 on a report that had no picture to drop', async () => {
      const { calls, impl } = scriptedFetch([{ ok: false, status: 413 }])
      const result = await sendFeedback(
        buildFeedbackPayload({ text: 'just words' }),
        ENDPOINT,
        impl
      )
      expect(result.ok).toBe(false)
      expect(calls).toHaveLength(1)
    })

    it('reports the second refusal honestly when the words are rejected too', async () => {
      const { impl } = scriptedFetch([{ ok: false, status: 413 }])
      const result = await sendFeedback(
        buildFeedbackPayload({
          image: 'data:image/jpeg;base64,AA==',
          text: 'x'
        }),
        ENDPOINT,
        impl
      )
      expect(result.ok).toBe(false)
      expect(result.failure).toEqual('too-large')
      expect(result.imageDropped).toBe(true)
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

    it('holds a second report instead of overwriting the first', () => {
      // The single slot was itself a way to lose the rider's words: a new
      // report replaced a held one that had never been delivered.
      const store = fakeStorage()
      queueFeedback(
        buildFeedbackPayload({ text: 'the 9.4 white border' }),
        store
      )
      queueFeedback(
        buildFeedbackPayload({ text: 'the one from IMG_3490' }),
        store
      )
      expect(readFeedbackQueue(store).map((p) => p.text)).toEqual([
        'the 9.4 white border',
        'the one from IMG_3490'
      ])
    })

    it('reads the pre-2026-09-06 single-object slot, because the rider has one', () => {
      const legacy = buildFeedbackPayload({ now: 3, text: 'still waiting' })
      const store = fakeStorage({
        [FEEDBACK_QUEUE_KEY]: JSON.stringify(legacy)
      })
      expect(readFeedbackQueue(store)).toEqual([legacy])
      expect(queuedFeedbackCount(store)).toEqual(1)
    })

    it('drops the picture on demand, so a 413 is not re-sent forever', () => {
      const store = fakeStorage()
      queueFeedback(
        buildFeedbackPayload({
          image: 'data:image/jpeg;base64,AAA=',
          text: 'too big for the route'
        }),
        store,
        { dropImage: true }
      )
      expect(readQueuedFeedback(store)?.image).toBeUndefined()
      expect(readQueuedFeedback(store)?.text).toEqual('too big for the route')
    })

    it('drops the pictures rather than the words when the hold is too big', () => {
      // localStorage is a few megabytes for the whole app, shared with saved
      // places and the Go Mode session snapshot. Base64 strings that already
      // failed to send must not be what evicts a live trip.
      const store = fakeStorage()
      queueFeedback(
        buildFeedbackPayload({
          image: `data:image/jpeg;base64,${'A'.repeat(500000)}`,
          text: 'the words that matter'
        }),
        store
      )
      const held = readFeedbackQueue(store)
      expect(held[0].text).toEqual('the words that matter')
      expect(held[0].image).toBeUndefined()
    })

    it('keeps the newest when more than the cap pile up', () => {
      const store = fakeStorage()
      for (let i = 1; i <= FEEDBACK_QUEUE_MAX_ITEMS + 2; i++)
        queueFeedback(buildFeedbackPayload({ text: `note ${i}` }), store)
      const held = readFeedbackQueue(store)
      expect(held).toHaveLength(FEEDBACK_QUEUE_MAX_ITEMS)
      expect(held[held.length - 1].text).toEqual(
        `note ${FEEDBACK_QUEUE_MAX_ITEMS + 2}`
      )
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

  describe('withoutImage', () => {
    it('leaves everything but the attachment', () => {
      const payload = buildFeedbackPayload({
        deviceId: 'dev-1',
        image: 'data:image/jpeg;base64,AA==',
        now: 4,
        text: 'x',
        tripId: 't'
      })
      expect(withoutImage(payload)).toEqual({
        deviceId: 'dev-1',
        source: 'feedback',
        text: 'x',
        tripId: 't',
        tsMs: 4
      })
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
      expect(result).toMatchObject({ delivered: 1, remaining: 0 })
      expect(calls[0].body.text).toEqual('held')
      expect(readFeedbackQueue(store)).toEqual([])
    })

    it('sends every held report, oldest first', async () => {
      const store = fakeStorage()
      queueFeedback(buildFeedbackPayload({ text: 'first' }), store)
      queueFeedback(buildFeedbackPayload({ text: 'second' }), store)
      const { calls, impl } = fakeFetch({ ok: true })
      const result = await flushQueuedFeedback(ENDPOINT, impl, store)
      expect(result?.delivered).toEqual(2)
      expect(calls.map((c) => c.body.text)).toEqual(['first', 'second'])
    })

    it('keeps the report when the retry fails too', async () => {
      // One attempt per visit, not one attempt ever: a retry that gave up for
      // good would be a second way to lose the rider's words.
      const store = fakeStorage()
      queueFeedback(buildFeedbackPayload({ text: 'still offline' }), store)
      const { impl } = fakeFetch({}, { ok: false, status: 502 })
      const result = await flushQueuedFeedback(ENDPOINT, impl, store)
      expect(result).toMatchObject({
        delivered: 0,
        failure: 'server',
        remaining: 1,
        status: 502
      })
      expect(readQueuedFeedback(store)?.text).toEqual('still offline')
    })

    it('strips the picture off a report the route 413s, so the hold stops poisoning itself', async () => {
      // This is the loop the rider was in: the held body was re-POSTed
      // unchanged on every visit and collected the same 413 every time.
      const store = fakeStorage()
      queueFeedback(
        buildFeedbackPayload({
          image: 'data:image/jpeg;base64,AAAA',
          text: 'held with a screenshot'
        }),
        store
      )
      const { impl } = scriptedFetch([{ ok: false, status: 413 }])
      const result = await flushQueuedFeedback(ENDPOINT, impl, store)
      expect(result).toMatchObject({ delivered: 0, failure: 'too-large' })
      expect(readQueuedFeedback(store)?.image).toBeUndefined()
      expect(readQueuedFeedback(store)?.text).toEqual('held with a screenshot')
    })

    it('reports the 403 the phone gets off the tailnet', async () => {
      const store = fakeStorage()
      queueFeedback(buildFeedbackPayload({ text: 'on cell data' }), store)
      const { impl } = fakeFetch({}, { ok: false, status: 403 })
      const result = await flushQueuedFeedback(ENDPOINT, impl, store)
      expect(result).toMatchObject({
        failure: 'not-allowed',
        remaining: 1,
        status: 403
      })
    })
  })
})
