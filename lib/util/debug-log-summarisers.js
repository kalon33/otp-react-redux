/**
 * debug-log-summarisers.js — per-action payload summarisers for the debug-log
 * middleware.
 *
 * Its own module for the same reason debug-log-entry.js and debug-log-batch.js
 * are: Jest cannot parse debug-log.js (its `import.meta`), so the testable
 * pieces live beside it rather than inside it.
 */

/**
 * Per-action payload summarisers, applied BEFORE the payload is stringified.
 *
 * A couple of action types carry a payload whose BULK is not the diagnostic:
 * recording it costs a 76 k `JSON.stringify` on the rider's phone and then
 * throws the result away, and the `__summary` stub it lands as says nothing a
 * reader can use. The caps are not the lever here — they were settled on
 * 2026-09-17 (backlog 17.10) and none of them moves; what a reader needs is
 * the FACT the action carried, recorded at the source (17.13).
 *
 * A summariser must return something small and must not throw: it runs inside
 * summarisePayload's try, so a throw degrades the entry to
 * `{ __unserialisable: true }`.
 *
 * A type listed here must NOT also be in full-capture-types.json: the
 * summariser wins over full capture, which would silently make a whitelisted
 * type unreplayable — the 2026-08-27 failure, by a different door.
 */
export const PAYLOAD_SUMMARISERS = {
  /*
   * UPDATE_LOCALE carries the entire flattened message catalogue — measured at
   * 76,334-76,856 chars across nine dispatches on 2026-09-15 (see
   * debug-2026-09-15.jsonl, e.g. entry mu2rh8xb-whmgwr-5). Every one of them
   * was already discarded by the generic stub below, so the catalogue never
   * reached the day file; what it cost was the stringify of it, nine times, on
   * a phone, for an entry that then read `keys: ["locale", "messages"]`.
   *
   * The locale and the catalogue size ARE diagnostic: a locale event during a
   * trip is worth seeing, and a message count that changes says the custom
   * overrides from config took effect.
   */
  UPDATE_LOCALE: (payload) => ({
    __summary: true,
    locale: payload?.locale,
    messageCount:
      payload?.messages && typeof payload.messages === 'object'
        ? Object.keys(payload.messages).length
        : undefined
  })
}
