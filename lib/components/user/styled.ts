import { Panel } from 'react-bootstrap'
import styled, { css } from 'styled-components'

import { getBaseColor, RED_ON_WHITE } from '../util/colors'
import { invisibleCss } from '../util/invisible-a11y-label'
import Link from '../util/link'

const baseColor = getBaseColor()

export const PageHeading = styled.h2`
  margin: 10px 0px 5px;
`

export const SequentialPaneContainer = styled.div`
  min-height: 20em;
`

export const StackedPaneContainer = styled.div`
  margin-bottom: 20px;
  padding-bottom: 20px;
  > h3 {
    margin-top: 0.5em;
    margin-bottom: 0.5em;
  }
`

export const SubNavContainer = styled.div`
  border-bottom: solid 1px #adadad;
  margin-bottom: 25px;
  padding: 5px 0px 10px 0px;
`

export const SubNavLinks = styled.div`
  margin-top: 11px;

  a {
    border: 1px transparent;
    border-bottom: 3px solid transparent;
    font-size: 17px;
    margin-left: 8px;
    padding: 6px 12px;
  }

  a.active {
    border-bottom: 3px solid #adadad;
  }
`

export const TripHeader = styled.h3`
  margin-top: 0px;
`

export const TripPanelTitle = styled.div`
  align-items: center;
  display: flex;
  gap: 10px;

  & > div:first-child {
    flex-grow: 1;
  }
`

export const TripPanelHeading = styled(Panel.Heading)`
  background-color: white !important;
  border-color: #fff !important;
  padding: 20px 25px 0 25px;
  max-width: 670px;

  a svg {
    color: ${baseColor};
  }

  h3 {
    margin: 0;
  }
`

export const TripPanelAlert = styled.span`
  background: none;
  border: none;
  color: ${RED_ON_WHITE};
  cursor: pointer;
  float: right;
  text-decoration: underline;
  &:hover {
    opacity: 80%;
  }
`

export const TripPanelFooter = styled(Panel.Footer)`
  background-color: white !important;
  border: none;
  padding: 0px;
`

/** Formats non-<label> elements like <label>s. */
const labelStyle = css`
  border: none;
  cursor: default;
  font-size: inherit;
  font-weight: 700;
  margin-bottom: 5px;
`

/** Fieldset with a legend that looks like labels. */
export const FieldSet = styled.fieldset`
  /* Format <legend> like labels. */
  legend {
    ${labelStyle}
  }
`

/** A container with spacing between controls. */
export const ControlStrip = styled.span`
  display: block;
  & > * {
    margin-right: 4px;
  }

  button {
    text-wrap: wrap;
    margin-top: 5px;
  }
`
/** Styles for phone editing fields */
export const phoneFieldStyle = css`
  display: inline-block;
  vertical-align: middle;
`

export const UnstyledLink = styled(Link)`
  color: initial;
  letter-spacing: initial;
  text-transform: none;

  &:hover {
    color: initial;
    text-decoration: none;
  }
`

/* --- "Share feedback" screen -------------------------------------------- */

/** The comment box. Sized so the whole of a 500-character note is visible. */
export const FeedbackTextarea = styled.textarea`
  border: 1px solid #adadad;
  border-radius: 4px;
  display: block;
  font-size: 16px;
  min-height: 8em;
  padding: 10px;
  resize: vertical;
  width: 100%;
`

/**
 * The attach row: our own button, plus the real `<input type="file">` kept in
 * the DOM but out of sight.
 *
 * The input is still the control that offers the camera, the photo library AND
 * the screenshot album on both iOS and Android with no native plugin behind it
 * — but WKWebView renders it as a bare "Choose File" pill and, once a file is
 * picked, appends its own preview: a broken-image glyph and the raw filename
 * ("IMG_3503.png"), which sat above OUR thumbnail of the same picture. That
 * doubled preview is what the rider called a "weird format" on 2026-09-08
 * 15:30:38. `invisibleCss` (not `display: none`) because a zero-size clipped
 * input still opens the picker from `.click()` everywhere, and the button
 * beside it carries the accessible name.
 */
export const FeedbackAttachRow = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 1em 0 0 0;

  input[type='file'] {
    ${invisibleCss}
    position: absolute;
  }
`

/**
 * The attached pictures, as a compact row.
 *
 * A row rather than a single slot because the shape of the thing is a list —
 * but the server takes exactly ONE `image` per POST (transitnav
 * preferences_api.py `_decode_feedback_image(data.get("image"))`, one string),
 * and 900,000 decoded bytes is already 1.2 MB of base64 against nginx's
 * 1536k body cap for `location /api/ride-note`. So the screen says "one
 * screenshot per report" out loud rather than offering a `multiple` picker
 * whose extra choices it would silently drop.
 */
export const FeedbackAttachments = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  list-style: none;
  margin: 12px 0 0 0;
  padding: 0;
`

/** One attachment: the picture, with its own remove control on its corner. */
export const FeedbackAttachment = styled.li`
  position: relative;
`

/** What the rider is about to send, at a size that proves it is the right one. */
export const FeedbackThumbnail = styled.img`
  border: 1px solid #adadad;
  border-radius: 4px;
  display: block;
  height: 96px;
  object-fit: cover;
  width: 96px;
`

/**
 * Remove, on the picture it removes.
 *
 * It used to be a full-width-ish bootstrap button floating at the vertical
 * middle of a 160 px thumbnail with nothing tying the two together; on the
 * rider's screenshot it reads as an unrelated control. Sized to the 44 px
 * touch target Apple asks for, minus the 8 px of overhang.
 */
export const FeedbackRemoveButton = styled.button`
  align-items: center;
  background: #fff;
  border: 1px solid #adadad;
  border-radius: 50%;
  color: #333;
  display: flex;
  font-size: 18px;
  height: 28px;
  justify-content: center;
  line-height: 1;
  padding: 0;
  position: absolute;
  right: -8px;
  top: -8px;
  width: 28px;

  &:focus {
    outline: 2px solid ${baseColor};
  }
`

/** Sent / held / failed. Never a spinner alone: the rider needs the words. */
export const FeedbackStatus = styled.p<{ $failed?: boolean }>`
  color: ${(props) => (props.$failed ? RED_ON_WHITE : '#186429')};
  font-size: 14px;
  font-weight: 700;
  margin: 1em 0 0 0;
`
