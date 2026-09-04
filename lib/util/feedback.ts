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

/**
 * Decoded-byte ceiling, matching FEEDBACK_IMAGE_MAX_BYTES on the server. The
 * ladder it sits in, all three rungs measured in bytes of the SAME request:
 *
 *   900,000 decoded  ->  1,200,000 base64 chars  + a ~1 KB JSON envelope
 *     < nginx client_max_body_size, 1,536 KiB = 1,572,864
 *       (otp-minneapolis deployment/nginx/otp-common.conf.tmpl, one file for
 *        both the house box and Linode)
 *
 * A 1280 px screenshot at quality 0.8 measures 150-400 KB, so the ceiling is
 * headroom for a photo from a real camera, not the ordinary case. It is
 * unrelated to the debug-log ladder in scripts/check-config-ladder.py — that one
 * governs a telemetry LINE, and an attachment never becomes one (see
 * _store_feedback_image: the server writes the bytes to disk and puts the path
 * in the record).
 */
export const FEEDBACK_MAX_IMAGE_BYTES = 900000

/** Single-slot hold for a report the network refused. */
export const FEEDBACK_QUEUE_KEY = 'otpFeedbackQueue'

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

export interface FeedbackResult {
  error?: string
  /** The server stored the attachment. False when it refused the picture — the
   * note is written either way, which is the whole point. */
  imageStored: boolean
  ok: boolean
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
 * Read one picked file, downscale it, and hand back a JPEG `data:` URL.
 *
 * `<input type="file" accept="image/*">` is what puts the camera, the photo
 * library AND the screenshot album in front of the rider on both iOS and
 * Android without a native plugin, and what comes back is a full-resolution
 * capture — 12 megapixels off a phone camera is several megabytes before base64
 * even doubles it. So it is always re-encoded, never passed through.
 *
 * Resolves to null if the file is not an image or the browser cannot draw it;
 * the caller sends the note without a picture rather than failing the report.
 */
export async function downscaleImage(
  file: File,
  maxEdge: number = FEEDBACK_MAX_EDGE_PX,
  quality: number = FEEDBACK_JPEG_QUALITY
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
    const { height, width } = scaledSize(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      maxEdge
    )
    if (!width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    // A picture the server would refuse is worse than no picture: it costs the
    // upload and comes back rejected. Drop it here and say so.
    if (base64Bytes(dataUrl) > FEEDBACK_MAX_IMAGE_BYTES) return null
    return dataUrl
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
      return { error: `http ${res.status}`, imageStored: false, ok: false }
    const body = await res.json()
    return {
      error: body?.imageError || undefined,
      imageStored: Boolean(body?.imageStored),
      ok: Boolean(body?.ok)
    }
  } catch (err) {
    return { error: String(err), imageStored: false, ok: false }
  }
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
 * One slot, not a list: this is the offline case, and a rider who is offline is
 * not composing a backlog. The picture is dropped when the whole thing is too
 * big to be a good tenant of localStorage — the words are what must survive.
 */
export function queueFeedback(
  payload: FeedbackPayload,
  explicit?: Storage | null
): boolean {
  const store = storage(explicit)
  if (!store) return false
  let serialised = JSON.stringify(payload)
  if (serialised.length > FEEDBACK_QUEUE_MAX_CHARS) {
    const { image, ...rest } = payload
    serialised = JSON.stringify(rest)
  }
  try {
    store.setItem(FEEDBACK_QUEUE_KEY, serialised)
    return true
  } catch {
    return false
  }
}

/** The held report, if there is one. */
export function readQueuedFeedback(
  explicit?: Storage | null
): FeedbackPayload | null {
  const store = storage(explicit)
  if (!store) return null
  try {
    const raw = store.getItem(FEEDBACK_QUEUE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.text !== 'string') return null
    return parsed as FeedbackPayload
  } catch {
    return null
  }
}

export function clearQueuedFeedback(explicit?: Storage | null): void {
  const store = storage(explicit)
  try {
    store?.removeItem(FEEDBACK_QUEUE_KEY)
  } catch {
    // Nothing to do: a storage that cannot be written cannot be cleared either.
  }
}

/**
 * Try the held report once.
 *
 * Once per visit to the screen, not once ever: a retry that gives up for good
 * would be a second way to lose the rider's words, which is the thing 9.3
 * exists to stop. It stays queued until it is actually delivered.
 */
export async function flushQueuedFeedback(
  endpoint: string,
  fetchImpl: typeof fetch = defaultFetch,
  explicit?: Storage | null
): Promise<FeedbackResult | null> {
  const queued = readQueuedFeedback(explicit)
  if (!queued) return null
  const result = await postFeedback(queued, endpoint, fetchImpl)
  if (result.ok) clearQueuedFeedback(explicit)
  return result
}
