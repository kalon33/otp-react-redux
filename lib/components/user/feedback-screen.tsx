import { Button } from 'react-bootstrap'
import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { apiUrl } from '../../util/api-base'
import {
  currentSessionId,
  getDeviceId,
  recordSessionEvent
} from '../../util/debug-log'
import {
  downscaleImage,
  FEEDBACK_MAX_CHARS,
  FeedbackFailure,
  FeedbackPayload,
  flushQueuedFeedback,
  isRetryable,
  buildFeedbackPayload as makePayload,
  queuedFeedbackCount,
  queueFeedback,
  sendFeedback
} from '../../util/feedback'
import { HelperText } from '../form/styled'
import AppFrame from '../app/app-frame'
import PageTitle from '../util/page-title'

import {
  FeedbackAttachRow,
  FeedbackStatus,
  FeedbackTextarea,
  FeedbackThumbnail
} from './styled'

const ENDPOINT = apiUrl('/api/ride-note')

type Status = 'failed' | 'held' | 'idle' | 'sending' | 'sent'

interface Props {
  tripId?: string
}

/**
 * "Share feedback": a comment box, a picture, and Send.
 *
 * Asked for mid-ride on 2026-09-04 at 15:07:30 (*"Let's add a share feedback
 * tab where users can afd comments and pictures or screenshots"*). It answers a
 * specific gap rather than a general wish: on that ride four of the five
 * findings were defects the rider could see and no rule could — the settings
 * page closing under a slider drag, the "Use this" list eating a third of the
 * card, a white line along the top border — and a UI defect emits no telemetry
 * at all. The only evidence such a thing has is a screenshot, and until now
 * there was no way for one to reach the record: every note of that ride got
 * there because the rider typed it into a tmux thread and it was POSTed by
 * hand, and the 15:10:07 note missed the trip-end request and is absent from
 * `riderNotes` entirely.
 *
 * It lands in exactly the sink the /ride console's notes land in
 * (`/api/ride-note`), so the ride-watch daemon reads it in stream order,
 * timestamps it against what the trip was doing at that second, and the
 * post-ride report cites the image by path. Nothing new had to be taught to the
 * daemon except to carry the path through.
 *
 * Reachable mid-trip without ending the trip: the app-menu item routes through
 * AppMenu._handleNavigate, which backgrounds Go Mode (SET_GO_MODE_BACKGROUNDED)
 * exactly as the Settings item does — tracking, notifications and the trip keep
 * running and the ReturnToTripBanner is the way back. Go Mode being active is
 * NOT a reason this screen holds a report: it posts unconditionally, and the
 * 2026-09-06 failure was the network, not the trip.
 *
 * TWO SERVER-SIDE BLOCKERS, both in otp-minneapolis
 * deployment/nginx/otp-common.conf.tmpl, `location /api/ride-note` (line 276).
 * Neither is fixable from here; both were measured on 2026-09-06 and both must
 * be deployed to the Linode before a screenshot can ever reach the record:
 *
 *   1. `allow 100.64.0.0/10; allow 127.0.0.1; deny all;` (lines 278-281) —
 *      tailnet only. The phone's telemetry on 2026-09-06 01:01 UTC all carried
 *      ip 65.128.203.6, its public cellular address, so every POST to this
 *      route was 403'd at nginx. The two feedback notes that DID land, on
 *      2026-09-05 16:55:52 and 16:56:42 UTC, carry ip 100.120.171.106 — the
 *      phone's tailnet address. That is the whole difference between the two
 *      days. Probe: POST to 172.238.175.38 -> HTTP 403.
 *      Fix: /api/ride-note is a WRITE. The ACL's own comment justifies itself
 *      by /api/ride-status leaking the rider's live location — which is a READ,
 *      and can keep the restriction. Split them.
 *
 *   2. `client_max_body_size 4k;` (line 288) — sized when the only client was
 *      the /ride console typing a sentence. Probe over the tailnet: a
 *      266,779-byte body -> HTTP 413 after 65,536 bytes sent; even a
 *      4,257-byte text-only body -> 413.
 *      Fix: 1536k, matching `location /api/debug-log` (line 195), which is the
 *      ladder lib/util/feedback.ts was written against all along.
 *
 * Until both ship, this screen's job is to be HONEST about it and to save the
 * rider's words: a 413 is retried without the picture so the sentence still
 * reaches `riderNotes`, and the status line names the reason instead of
 * promising a delivery that cannot happen.
 */
const FeedbackScreen = ({ tripId }: Props): JSX.Element => {
  const intl = useIntl()
  const [text, setText] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [detail, setDetail] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const heading = intl.formatMessage({
    defaultMessage: 'Share feedback',
    id: 'components.FeedbackScreen.heading'
  })

  /**
   * The sentence shown when a report did not go out.
   *
   * One per reason, because the single sentence this replaced — "Saved. It will
   * send the next time you open this screen." — was false for the two reasons
   * that actually fire. A 403 (off the tailnet) and a 413 (picture too big for
   * the route) are deterministic: the identical request fails identically on
   * every visit, and the old copy promised delivery anyway while the report sat
   * there for two days. Say what happened, and only promise a retry when a
   * retry could work.
   */
  const explainFailure = useCallback(
    (failure: FeedbackFailure | undefined, status: number | undefined) => {
      if (failure === 'too-large')
        return intl.formatMessage({
          defaultMessage:
            'The server would not accept a report this large, even without the picture. Saved — try again later.',
          id: 'components.FeedbackScreen.failedTooLarge'
        })
      if (failure === 'not-allowed')
        return intl.formatMessage(
          {
            defaultMessage:
              'The server refused this report ({status}). It is saved, but it will not go out from this network — reconnect to Tailscale and open this screen again.',
            id: 'components.FeedbackScreen.failedNotAllowed'
          },
          { status: status ?? 403 }
        )
      if (failure === 'network')
        return intl.formatMessage({
          defaultMessage:
            'No connection. Saved — it will go out next time you open this screen.',
          id: 'components.FeedbackScreen.heldOffline'
        })
      return intl.formatMessage(
        {
          defaultMessage:
            'The server could not take it ({status}). Saved — it will go out next time you open this screen.',
          id: 'components.FeedbackScreen.heldServer'
        },
        { status: status ?? 0 }
      )
    },
    [intl]
  )

  // Reports the network refused get one attempt per visit. Not one attempt
  // ever: giving up for good would be a second way to lose the rider's words,
  // which is the thing this screen exists to stop.
  useEffect(() => {
    let cancelled = false
    if (!queuedFeedbackCount()) return
    setStatus('held')
    setDetail(
      intl.formatMessage({
        defaultMessage: 'Sending an earlier report that could not go out…',
        id: 'components.FeedbackScreen.sendingHeld'
      })
    )
    flushQueuedFeedback(ENDPOINT).then((result) => {
      if (cancelled || !result) return
      recordSessionEvent('feedback-flush', {
        delivered: result.delivered,
        failure: result.failure,
        imageDropped: result.imageDropped,
        remaining: result.remaining,
        status: result.status
      })
      if (!result.remaining) {
        setStatus('sent')
        setDetail(
          intl.formatMessage(
            {
              defaultMessage:
                '{count, plural, one {An earlier report has} other {# earlier reports have}} now been sent.',
              id: 'components.FeedbackScreen.heldSent'
            },
            { count: result.delivered }
          )
        )
        return
      }
      setStatus('held')
      setDetail(explainFailure(result.failure, result.status))
    })
    return () => {
      cancelled = true
    }
    // Once, on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTextChange = useCallback(
    (evt: React.ChangeEvent<HTMLTextAreaElement>) => setText(evt.target.value),
    []
  )

  const onPickImage = useCallback(
    async (evt: React.ChangeEvent<HTMLInputElement>) => {
      const file = evt.target.files?.[0]
      if (!file) {
        setImage(null)
        return
      }
      const dataUrl = await downscaleImage(file)
      setImage(dataUrl)
      if (!dataUrl) {
        setStatus('failed')
        setDetail(
          intl.formatMessage({
            defaultMessage: 'That file could not be attached.',
            id: 'components.FeedbackScreen.imageRejected'
          })
        )
      } else if (status === 'failed') {
        setStatus('idle')
        setDetail(null)
      }
    },
    [intl, status]
  )

  const onRemoveImage = useCallback(() => {
    setImage(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [])

  const onSend = useCallback(async () => {
    const payload: FeedbackPayload = makePayload({
      deviceId: getDeviceId(),
      image,
      sessionId: currentSessionId(),
      text,
      tripId
    })
    setStatus('sending')
    setDetail(null)

    // The held reports go FIRST, and their delivery is the only thing that
    // releases them. The line this replaces was `clearQueuedFeedback()` on the
    // success of THIS report, on the reasoning that "whatever was being held is
    // either this or older" — but a held report is a different report, with
    // different words and a different screenshot, so a successful send silently
    // destroyed it. That is how the rider's 9.4 white-border screenshot would
    // have gone had anything ever succeeded.
    const flushed = await flushQueuedFeedback(ENDPOINT)

    const result = await sendFeedback(payload, ENDPOINT)
    // Recorded so this failure is never again invisible. It was: postFeedback
    // swallows every error by design, the screen showed one sentence for all of
    // them, and the 2026-09-06 debug log carries 789 events from that session
    // and not one trace of the POST. Finding the cause needed a probe against
    // production, which is not a thing a rider can do.
    recordSessionEvent('feedback-send', {
      failure: result.failure,
      hasImage: Boolean(payload.image),
      imageDropped: result.imageDropped,
      imageStored: result.imageStored,
      ok: result.ok,
      status: result.status,
      textChars: payload.text.length
    })

    if (result.ok) {
      setText('')
      setImage(null)
      if (fileRef.current) fileRef.current.value = ''
      setStatus('sent')
      if (flushed?.remaining) {
        // This one landed and an older one still has not. Saying so is the
        // point: the rider spent two days believing a report was on its way.
        setDetail(
          intl.formatMessage(
            {
              defaultMessage:
                'Sent. {count, plural, one {An earlier report is} other {# earlier reports are}} still waiting — {reason}',
              id: 'components.FeedbackScreen.sentOthersWaiting'
            },
            {
              count: flushed.remaining,
              reason: explainFailure(flushed.failure, flushed.status)
            }
          )
        )
        return
      }
      setDetail(
        result.imageDropped || (payload.image && !result.imageStored)
          ? intl.formatMessage({
              defaultMessage: 'Sent, but the picture could not be attached.',
              id: 'components.FeedbackScreen.sentWithoutImage'
            })
          : intl.formatMessage({
              defaultMessage: 'Sent. Thank you.',
              id: 'components.FeedbackScreen.sent'
            })
      )
      return
    }

    // A body the route refused for its SIZE must not be held as-is: every later
    // visit would re-POST the same bytes and collect the same 413 forever.
    const dropImage = result.failure === 'too-large'
    const held = queueFeedback(payload, undefined, { dropImage })
    setStatus(held && isRetryable(result.failure) ? 'held' : 'failed')
    setDetail(
      held
        ? explainFailure(result.failure, result.status)
        : intl.formatMessage({
            defaultMessage:
              'Could not send, and this device has no room to save it. Try again.',
            id: 'components.FeedbackScreen.failed'
          })
    )
  }, [explainFailure, image, intl, text, tripId])

  const nothingToSend = !text.trim() && !image

  return (
    <AppFrame>
      <PageTitle title={heading} />
      <h1>{heading}</h1>
      <HelperText>
        {intl.formatMessage({
          defaultMessage:
            'Tell us what went wrong. A screenshot says more than a sentence.',
          id: 'components.FeedbackScreen.intro'
        })}
      </HelperText>

      <FeedbackTextarea
        aria-label={intl.formatMessage({
          defaultMessage: 'Your comment',
          id: 'components.FeedbackScreen.commentLabel'
        })}
        maxLength={FEEDBACK_MAX_CHARS}
        onChange={onTextChange}
        placeholder={intl.formatMessage({
          defaultMessage: 'What happened?',
          id: 'components.FeedbackScreen.commentPlaceholder'
        })}
        value={text}
      />

      <FeedbackAttachRow>
        {/* accept="image/*" is what puts the camera, the photo library and the
            screenshot album in front of the rider on iOS and Android alike. */}
        <input
          accept="image/*"
          aria-label={intl.formatMessage({
            defaultMessage: 'Add a photo or screenshot',
            id: 'components.FeedbackScreen.attachLabel'
          })}
          onChange={onPickImage}
          ref={fileRef}
          type="file"
        />
        {image && (
          <>
            <FeedbackThumbnail
              alt={intl.formatMessage({
                defaultMessage: 'The picture you attached',
                id: 'components.FeedbackScreen.thumbnailAlt'
              })}
              src={image}
            />
            <Button bsSize="small" onClick={onRemoveImage}>
              {intl.formatMessage({
                defaultMessage: 'Remove',
                id: 'components.FeedbackScreen.removeImage'
              })}
            </Button>
          </>
        )}
      </FeedbackAttachRow>

      <Button
        bsStyle="primary"
        disabled={nothingToSend || status === 'sending'}
        onClick={onSend}
      >
        {intl.formatMessage({
          defaultMessage: 'Send',
          id: 'components.FeedbackScreen.send'
        })}
      </Button>

      {detail && (
        <FeedbackStatus
          $failed={status === 'failed' || status === 'held'}
          className="feedback-status"
          role="status"
        >
          {detail}
        </FeedbackStatus>
      )}
    </AppFrame>
  )
}

const mapStateToProps = (state: any) => {
  const goMode = state.otp.goMode
  // The trip the rider is actually on if the vehicle is known, otherwise the
  // first transit leg of the itinerary they are following. Descriptive only —
  // the daemon still correlates the note by timestamp — but it is what ties a
  // screenshot to an itinerary once the day's log has rolled over.
  const legTripId = goMode?.activeItinerary?.legs?.find(
    (leg: any) => leg?.transitLeg
  )?.trip?.gtfsId
  return { tripId: goMode?.riding?.tripId || legTripId }
}

export default connect(mapStateToProps)(FeedbackScreen)
