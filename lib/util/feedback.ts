/**
 * The "Share feedback" screen's data layer: shrink a photo, build the note, put
 * it on the wire, and hold it if the wire is down.
 *
 * Why this exists (backlog 9.3, from the 2026-09-04 15:04 ride): four of that
 * ride's five findings were things the rider could SEE and the telemetry could
 * not express — a settings page that closed under a drag, a list that took a
 * third of the card, a white line along the top border. Every one of them
 * reached the record only because the rider typed it into a tmux thread and
 * somebody POSTed it by hand; the note typed at 15:10:07 missed the trip-end
 * request entirely and is absent from `riderNotes`. A screenshot is the only
 * evidence such a defect has, so the picture is the point, not a nicety.
 *
 * The sink is the ride-note endpoint the /ride console already uses
 * (`/api/ride-note`, transitnav preferences_api.py): same JSONL, same
 * day-rollover, same append-under-lock, so ride-watch picks the note up in
 * stream order and pins it to whatever the trip was doing at that second. The
 * only addition is `image`.
 *
 * NO `import.meta` in this file, deliberately. Vite's env object is a syntax
 * error under jest's CJS transform, which is why `lib/util/debug-log.js` and
 * `lib/util/go-mode/onboard-discovery.js` both have to be replaced by hand-written
 * mocks in package.json's moduleNameMapper. The endpoint and the rider's
 * identity are passed in from the screen instead, and this module stays a plain
 * unit under test.
 */

/** The server's own cap on a note body (RIDE_NOTE_MAX_CHARS). Trim here so the
 * rider sees the limit rather than discovering it after the fact. */
export const FEEDBACK_MAX_CHARS = 500

/** Longest edge, in CSS pixels, of the image actually sent. */
export const FEEDBACK_MAX_EDGE_PX = 1280

/** JPEG quality for the downscale. */
export const FEEDBACK_JPEG_QUALITY = 0.8

export interface DownscaleStep {
  maxEdge: number
  quality: number
}

/**
 * Tried in order until one fits the byte budget.
 *
 * There used to be exactly one rung, and a picture that missed it was thrown
 * away with "That file could not be attached." — the rider loses the only
 * evidence a UI defect ever has because the first guess at a JPEG quality came
 * out 40 KB heavy. A detailed 12 MP camera frame at 1280/0.8 clears 900 KB
 * often enough to matter. Re-encoding smaller costs one more `toDataURL` on a
 * canvas that is already drawn, and a 800 px screenshot is still legible
 * evidence; an absent one is not.
 */
export const FEEDBACK_DOWNSCALE_STEPS: readonly DownscaleStep[] = [
  { maxEdge: FEEDBACK_MAX_EDGE_PX, quality: FEEDBACK_JPEG_QUALITY },
  { maxEdge: 1024, quality: 0.7 },
  { maxEdge: 800, quality: 0.6 }
]

/**
 * Decoded-byte ceiling, matching FEEDBACK_IMAGE_MAX_BYTES on the server.
 *
 * READ THE ROUTE, NOT THE NEIGHBOURING ROUTE. Until 2026-09-06 this comment
 * cited `client_max_body_size 1536k` and named
 * otp-minneapolis deployment/nginx/otp-common.conf.tmpl — but 1536k is the cap
 * on `location /api/debug-log` (line 195 of that file). The route this module
 * actually POSTs to, `location /api/ride-note`, carries
 * `client_max_body_size 4k` (line 288), sized when the only client was the
 * /ride console typing a sentence. Every report with a picture therefore died
 * at nginx with a 413 that never reached Flask, and the hold retried the same
 * oversized body forever. Measured 2026-09-06: a 266,779-byte body to
 * https://api.transit-nav.com:9966/api/ride-note over the tailnet returned
 * HTTP 413 after 65,536 bytes were sent; a 4,257-byte text-only body returned
 * 413 too.
 *
 * So the ladder is only true once the route's cap is raised to match
 * /api/debug-log:
 *
 *   900,000 decoded  ->  1,200,000 base64 chars  + a ~1 KB JSON envelope
 *     < nginx client_max_body_size on `location /api/ride-note`
 *       (1,536 KiB = 1,572,864 — NOT YET DEPLOYED, see the header of
 *        feedback-screen.tsx)
 *
 * Until then the client cannot know the cap, so it does not pretend to: a 413
 * is handled by retrying without the picture (`sendFeedback`) so the words
 * still reach the record, and the rider is told the picture was refused rather
 * than that the report is "saved".
 *
 * A 1280 px screenshot at quality 0.8 measures 150-400 KB, so the ceiling is
 * headroom for a photo from a real camera, not the ordinary case. It is
 * unrelated to the debug-log ladder in scripts/check-config-ladder.py — that one
 * governs a telemetry LINE, and an attachment never becomes one (see
 * _store_feedback_image: the server writes the bytes to disk and puts the path
 * in the record).
 */
export const FEEDBACK_MAX_IMAGE_BYTES = 900000

/** Where reports the network refused wait for another try. */
export const FEEDBACK_QUEUE_KEY = 'otpFeedbackQueue'

/**
 * How many refused reports are held at once.
 *
 * It was one, and that single slot was the second way the rider's words got
 * lost. Two of them: `onSend` cleared the slot on ANY successful send, on the
 * reasoning that "whatever was being held is either this or older" — but a held
 * report is a DIFFERENT report, with different words and a different
 * screenshot, so sending a new one silently destroyed the old one. And a new
 * report that failed overwrote the held one for the same reason. Both are gone
 * with a short list: nothing is discarded except by being delivered.
 *
 * Three, not thirty: this is the offline case, and a rider who is offline is
 * not composing a backlog.
 */
export const FEEDBACK_QUEUE_MAX_ITEMS = 3

/**
 * Above this, a queued report is held WITHOUT its picture. localStorage is a
 * few megabytes for the whole app and it is where saved places, the Go Mode
 * session snapshot and the routing profiles live; a 1.2 MB base64 string that
 * failed to send once must not be what evicts a live trip.
 */
export const FEEDBACK_QUEUE_MAX_CHARS = 400000

export interface FeedbackPayload {
  deviceId?: string
  /** base64 or a `data:` URL. Absent when the rider attached nothing. */
  image?: string
  sessionId?: string
  source: 'feedback'
  text: string
  /** The trip the rider was looking at, when Go Mode has one. */
  tripId?: string
  tsMs: number
}

/**
 * Why a report did not go out. The screen shows the rider a different sentence
 * for each, because "Saved. It will send the next time you open this screen."
 * was a lie for three of the five: a 403 and a 413 will be refused identically
 * on every retry for as long as the rider stays on that network with that
 * picture, and the old code promised delivery anyway.
 */
export type FeedbackFailure =
  /** fetch() threw: airplane mode, no cell, DNS, TLS. A retry is the fix. */
  | 'network'
  /** 401/403 — the route refused THIS CLIENT. See the ACL note in
   *  feedback-screen.tsx: /api/ride-note is `allow 100.64.0.0/10; deny all`, so
   *  the phone is refused whenever it is off the tailnet. */
  | 'not-allowed'
  /** 429 — too many notes too fast. Worth another try shortly. */
  | 'rate-limited'
  /** 5xx and anything unclassified. Worth another try. */
  | 'server'
  /** 413 — the body exceeded nginx's client_max_body_size for the route. */
  | 'too-large'

export interface FeedbackResult {
  error?: string
  /** The failure kind, when `ok` is false. */
  failure?: FeedbackFailure
  /** The picture was dropped and the words sent alone, because the route
   * refused the body for its size. The report reached the record; the evidence
   * did not, and the rider is told so. */
  imageDropped: boolean
  /** The server stored the attachment. False when it refused the picture — the
   * note is written either way, which is the whole point. */
  imageStored: boolean
  ok: boolean
  /** The HTTP status, when there was a response at all. */
  status?: number
}

/**
 * Whether trying the same bytes again could plausibly work.
 *
 * This is what the rider is actually told. A 403 (wrong network) or a 413 (too
 * big for the route) is deterministic: the same request will fail the same way
 * every time, so promising "it will send next time you open this screen" is
 * false. Offline, rate-limited and 5xx are transient, and there the promise is
 * true.
 */
export function isRetryable(failure?: FeedbackFailure): boolean {
  return (
    failure === 'network' || failure === 'rate-limited' || failure === 'server'
  )
}

/** Map one HTTP status onto the reason the rider is shown. */
export function classifyStatus(status: number): FeedbackFailure {
  if (status === 413) return 'too-large'
  if (status === 401 || status === 403) return 'not-allowed'
  if (status === 429) return 'rate-limited'
  return 'server'
}

/**
 * The size an image is sent at: the longest edge clamped to `maxEdge`, aspect
 * preserved, never upscaled. Whole pixels, because canvas dimensions are
 * integers and a fractional height silently truncates.
 */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number = FEEDBACK_MAX_EDGE_PX
): { height: number; width: number } {
  if (!(width > 0) || !(height > 0)) return { height: 0, width: 0 }
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { height, width }
  const scale = maxEdge / longest
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale))
  }
}

/** How many bytes a base64 string (or `data:` URL) decodes to. */
export function base64Bytes(value: string): number {
  const body = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  if (!body) return 0
  let padding = 0
  if (body.endsWith('==')) padding = 2
  else if (body.endsWith('=')) padding = 1
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
}

/**
 * Walk a ladder of encodings and return the first that fits the byte budget.
 *
 * Separated from the canvas so the ladder itself is testable: jsdom has no 2d
 * context and `toDataURL` there is a stub, which is exactly why the old
 * single-rung version shipped with no test at all.
 *
 * Returns null only when every rung is still over budget — at which point the
 * picture genuinely cannot be sent and the caller says so rather than pretending.
 */
export function encodeWithinBudget(
  encode: (step: DownscaleStep) => string | null,
  steps: readonly DownscaleStep[] = FEEDBACK_DOWNSCALE_STEPS,
  maxBytes: number = FEEDBACK_MAX_IMAGE_BYTES
): string | null {
  for (const step of steps) {
    const dataUrl = encode(step)
    // A rung the encoder could not produce is skipped, not fatal: a smaller one
    // may still work.
    if (!dataUrl) continue
    if (base64Bytes(dataUrl) <= maxBytes) return dataUrl
  }
  return null
}

/**
 * Read one picked file, downscale it, and hand back a JPEG `data:` URL.
 *
 * `<input type="file" accept="image/*">` is what puts the camera, the photo
 * library AND the screenshot album in front of the rider on both iOS and
 * Android without a native plugin, and what comes back is a full-resolution
 * capture — the rider's IMG_3490.png on 2026-09-06 was a full-resolution iPhone
 * screenshot, and 12 megapixels off a phone camera is several megabytes before
 * base64 even doubles it. So it is always re-encoded, never passed through, and
 * re-encoded down a ladder rather than once (FEEDBACK_DOWNSCALE_STEPS).
 *
 * Resolves to null if the file is not an image, the browser cannot draw it, or
 * no rung of the ladder fits; the caller sends the note without a picture
 * rather than failing the report.
 */
export async function downscaleImage(
  file: File,
  steps: readonly DownscaleStep[] = FEEDBACK_DOWNSCALE_STEPS,
  maxBytes: number = FEEDBACK_MAX_IMAGE_BYTES
): Promise<string | null> {
  if (!file || !/^image\//.test(file.type || '')) return null
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode failed'))
      el.src = url
    })
    const naturalW = image.naturalWidth || image.width
    const naturalH = image.naturalHeight || image.height
    return encodeWithinBudget(
      ({ maxEdge, quality }) => {
        const { height, width } = scaledSize(naturalW, naturalH, maxEdge)
        if (!width || !height) return null
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(image, 0, 0, width, height)
        return canvas.toDataURL('image/jpeg', quality)
      },
      steps,
      maxBytes
    )
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * The wire shape: the ride-note payload the /ride console already sends, plus
 * `image`. `source: 'feedback'` is what lets the daemon and the report tell an
 * in-app report from a note typed on the console.
 */
export function buildFeedbackPayload({
  deviceId,
  image,
  now,
  sessionId,
  text,
  tripId
}: {
  deviceId?: string | null
  image?: string | null
  now?: number
  sessionId?: string | null
  text: string
  tripId?: string | null
}): FeedbackPayload {
  const payload: FeedbackPayload = {
    source: 'feedback',
    // Carrying the tap time, not the arrival time: a report written in a tunnel
    // and sent twenty minutes later still belongs where it was written.
    text: (text || '').trim().slice(0, FEEDBACK_MAX_CHARS),
    tsMs: now ?? Date.now()
  }
  if (deviceId) payload.deviceId = deviceId
  if (sessionId) payload.sessionId = sessionId
  if (tripId) payload.tripId = tripId
  if (image) payload.image = image
  return payload
}

/** The same report with the attachment removed, for the routes that refuse it. */
export function withoutImage(payload: FeedbackPayload): FeedbackPayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { image, ...rest } = payload
  return rest
}

/** Whether there is anything to send at all. */
export function isSendable(payload: FeedbackPayload): boolean {
  return Boolean(payload.text || payload.image)
}

/**
 * The default sender. An arrow, not a bare `fetch` reference: a detached
 * `fetch` is a WebIDL operation invoked with the wrong `this`, and while Chrome
 * and WebKit both tolerate it today, the failure if one ever stops would be
 * on-device only and would look like "feedback silently never sends".
 */
const defaultFetch: typeof fetch = (...args) => fetch(...args)

/** POST one report. Never throws: a network failure is a result, not an error. */
export async function postFeedback(
  payload: FeedbackPayload,
  endpoint: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<FeedbackResult> {
  try {
    const res = await fetchImpl(endpoint, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
    if (!res.ok)
      return {
        error: `http ${res.status}`,
        failure: classifyStatus(res.status),
        imageDropped: false,
        imageStored: false,
        ok: false,
        status: res.status
      }
    const body = await res.json()
    return {
      error: body?.imageError || undefined,
      imageDropped: false,
      imageStored: Boolean(body?.imageStored),
      ok: Boolean(body?.ok),
      status: res.status
    }
  } catch (err) {
    // No response at all: airplane mode, no cell, DNS, a TLS handshake that
    // never completed. `fetch` rejects identically for all of them.
    return {
      error: String(err),
      failure: 'network',
      imageDropped: false,
      imageStored: false,
      ok: false
    }
  }
}

/**
 * Send one report, and if the route refuses it for its SIZE, send the words
 * alone.
 *
 * This is the whole recovery from the 2026-09-06 defect. `location
 * /api/ride-note` carries `client_max_body_size 4k`, so a report with any
 * screenshot at all is 413'd at nginx and never reaches Flask — and the old
 * code then held the identical oversized body and re-POSTed it on every visit,
 * forever. Dropping the picture and retrying costs one small request and gets
 * the rider's sentence into `riderNotes`, which is the thing the screen exists
 * to guarantee. The picture's loss is reported (`imageDropped`), never hidden.
 *
 * Only 413 triggers it. A 403 is not about the bytes and re-sending without the
 * picture would fail the same way, so it is left alone.
 */
export async function sendFeedback(
  payload: FeedbackPayload,
  endpoint: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<FeedbackResult> {
  const first = await postFeedback(payload, endpoint, fetchImpl)
  if (first.ok || first.failure !== 'too-large' || !payload.image) return first
  const second = await postFeedback(withoutImage(payload), endpoint, fetchImpl)
  return { ...second, imageDropped: true }
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'removeItem' | 'setItem'>

function storage(explicit?: Storage | null): Storage | null {
  if (explicit) return explicit
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Hold a report the network refused, so closing the screen does not destroy it.
 *
 * A short LIST, not the single slot this started with. The slot was itself a
 * way to lose the rider's words: `onSend` cleared it on any successful send
 * ("whatever was being held is either this or older"), and a failed send
 * overwrote it — either way a held report with its own screenshot vanished the
 * moment a second report was written. Nothing here is discarded except by
 * being delivered, or by being pushed off the end of a three-deep list.
 *
 * `dropImage` is passed when the route refused the body for its SIZE. Holding
 * bytes that were just 413'd turns the queue into a permanent blocker: every
 * later visit re-POSTs the same oversized body and gets the same 413. The words
 * are what must survive.
 */
export function queueFeedback(
  payload: FeedbackPayload,
  explicit?: Storage | null,
  { dropImage = false }: { dropImage?: boolean } = {}
): boolean {
  const store = storage(explicit)
  if (!store) return false
  const queue = readFeedbackQueue(explicit)
  queue.push(dropImage ? withoutImage(payload) : payload)
  return writeFeedbackQueue(queue, explicit)
}

/**
 * Persist the queue, shedding weight until it is a decent tenant of
 * localStorage.
 *
 * localStorage is a few megabytes for the whole app and it is where saved
 * places, the Go Mode session snapshot and the routing profiles live; base64
 * screenshots that failed to send must not be what evicts a live trip. Pictures
 * go first and oldest-first, then whole reports off the front — a rider who
 * writes a fourth report while three are stuck cares most about the fourth.
 */
function writeFeedbackQueue(
  queue: FeedbackPayload[],
  explicit?: Storage | null
): boolean {
  const store = storage(explicit)
  if (!store) return false
  let kept = queue.slice(-FEEDBACK_QUEUE_MAX_ITEMS)
  for (let i = 0; i < kept.length; i++) {
    if (JSON.stringify(kept).length <= FEEDBACK_QUEUE_MAX_CHARS) break
    kept = kept.map((item, j) => (j <= i ? withoutImage(item) : item))
  }
  while (
    kept.length > 1 &&
    JSON.stringify(kept).length > FEEDBACK_QUEUE_MAX_CHARS
  )
    kept = kept.slice(1)
  try {
    store.setItem(FEEDBACK_QUEUE_KEY, JSON.stringify(kept))
    return true
  } catch {
    return false
  }
}

/**
 * Everything currently held, oldest first.
 *
 * Reads the pre-2026-09-06 single-object shape too. That is not tidiness: the
 * rider's phone has a report sitting in that slot right now — the one the
 * screen has been calling "an earlier report is still waiting to send" — and an
 * upgrade that failed to parse it would be the fourth way this feature lost it.
 */
export function readFeedbackQueue(
  explicit?: Storage | null
): FeedbackPayload[] {
  const store = storage(explicit)
  if (!store) return []
  try {
    const raw = store.getItem(FEEDBACK_QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    return items.filter(
      (item) => item && typeof item.text === 'string'
    ) as FeedbackPayload[]
  } catch {
    return []
  }
}

/** The oldest held report, if there is one. */
export function readQueuedFeedback(
  explicit?: Storage | null
): FeedbackPayload | null {
  return readFeedbackQueue(explicit)[0] || null
}

/** How many reports are waiting. */
export function queuedFeedbackCount(explicit?: Storage | null): number {
  return readFeedbackQueue(explicit).length
}

export function clearQueuedFeedback(explicit?: Storage | null): void {
  const store = storage(explicit)
  try {
    store?.removeItem(FEEDBACK_QUEUE_KEY)
  } catch {
    // Nothing to do: a storage that cannot be written cannot be cleared either.
  }
}

export interface FeedbackFlushResult {
  /** How many held reports reached the record this time. */
  delivered: number
  /** Why the last one that failed, failed — what the rider is told. */
  failure?: FeedbackFailure
  /** True when at least one report was delivered without its picture. */
  imageDropped: boolean
  /** How many are still waiting afterwards. */
  remaining: number
  status?: number
}

/**
 * Try every held report once, oldest first, and keep the ones that still fail.
 *
 * Once per visit, not once ever: a retry that gives up for good would be a
 * second way to lose the rider's words, which is the thing 9.3 exists to stop.
 * Delivered reports leave the queue; the rest stay, minus any picture the route
 * refused for its size — otherwise a 413'd body is re-sent unchanged on every
 * visit for the life of the install, which is precisely what happened between
 * the two reports the rider wrote on 2026-09-05 and 2026-09-06.
 */
export async function flushQueuedFeedback(
  endpoint: string,
  fetchImpl: typeof fetch = defaultFetch,
  explicit?: Storage | null
): Promise<FeedbackFlushResult | null> {
  const queue = readFeedbackQueue(explicit)
  if (!queue.length) return null
  const stuck: FeedbackPayload[] = []
  let delivered = 0
  let imageDropped = false
  let failure: FeedbackFailure | undefined
  let status: number | undefined
  for (const item of queue) {
    const result = await sendFeedback(item, endpoint, fetchImpl)
    if (result.ok) {
      delivered++
      if (result.imageDropped) imageDropped = true
      continue
    }
    failure = result.failure
    status = result.status
    stuck.push(result.failure === 'too-large' ? withoutImage(item) : item)
  }
  if (stuck.length) writeFeedbackQueue(stuck, explicit)
  else clearQueuedFeedback(explicit)
  return { delivered, failure, imageDropped, remaining: stuck.length, status }
}
