import { Button } from 'react-bootstrap'
import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  clearQueuedFeedback,
  downscaleImage,
  FEEDBACK_MAX_CHARS,
  FeedbackPayload,
  flushQueuedFeedback,
  buildFeedbackPayload as makePayload,
  postFeedback,
  queueFeedback,
  readQueuedFeedback
} from '../../util/feedback'
import { currentSessionId, getDeviceId } from '../../util/debug-log'
import { HelperText } from '../form/styled'
import AppFrame from '../app/app-frame'
import PageTitle from '../util/page-title'

import {
  FeedbackAttachRow,
  FeedbackStatus,
  FeedbackTextarea,
  FeedbackThumbnail
} from './styled'

// Same rule as debug-log.js and onboard-discovery.js: web builds are
// same-origin behind the auth gate and leave this unset; the bundled native app
// runs at capacitor://localhost (iOS) or https://localhost (Android) and sets
// the base to the server's absolute URL, so the call goes cross-origin. Both
// native origins are in the endpoint's ALLOWED_ORIGINS.
// The cast is because this is the first TS file to read Vite's env: the repo's
// tsconfig has no `vite/client` types, so `import.meta.env` is untyped here
// while the three .js callers above compile without it.
const API_BASE =
  (typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_API_BASE_URL) ||
  ''
const ENDPOINT = `${API_BASE}/api/ride-note`

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
 * running and the ReturnToTripBanner is the way back.
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

  // A report the network refused last time gets one attempt per visit. Not one
  // attempt ever: giving up for good would be a second way to lose the rider's
  // words, which is the thing this screen exists to stop.
  useEffect(() => {
    let cancelled = false
    if (!readQueuedFeedback()) return
    setStatus('held')
    setDetail(
      intl.formatMessage({
        defaultMessage: 'Sending an earlier report that could not go out…',
        id: 'components.FeedbackScreen.sendingHeld'
      })
    )
    flushQueuedFeedback(ENDPOINT).then((result) => {
      if (cancelled) return
      if (result?.ok) {
        setStatus('sent')
        setDetail(
          intl.formatMessage({
            defaultMessage: 'An earlier report has now been sent.',
            id: 'components.FeedbackScreen.heldSent'
          })
        )
      } else {
        setStatus('held')
        setDetail(
          intl.formatMessage({
            defaultMessage:
              'An earlier report is still waiting to send. It will go out next time you open this screen.',
            id: 'components.FeedbackScreen.heldWaiting'
          })
        )
      }
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
    const result = await postFeedback(payload, ENDPOINT)
    if (result.ok) {
      // Delivered: whatever was being held is either this or older, and either
      // way it is no longer the thing that must not be lost.
      clearQueuedFeedback()
      setText('')
      setImage(null)
      if (fileRef.current) fileRef.current.value = ''
      setStatus('sent')
      setDetail(
        payload.image && !result.imageStored
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
    const held = queueFeedback(payload)
    setStatus(held ? 'held' : 'failed')
    setDetail(
      held
        ? intl.formatMessage({
            defaultMessage:
              'Saved. It will send the next time you open this screen.',
            id: 'components.FeedbackScreen.held'
          })
        : intl.formatMessage({
            defaultMessage: 'Could not send. Try again.',
            id: 'components.FeedbackScreen.failed'
          })
    )
  }, [image, intl, text, tripId])

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
