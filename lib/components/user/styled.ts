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

/**
 * The comment box. Sized so the whole of a 500-character note is visible.
 * On the phone it is the page's card: surface on the --tn-bg ground, no
 * border, an accent ring while typing.
 */
export const FeedbackTextarea = styled.textarea`
  border: 1px solid #adadad;
  border-radius: 4px;
  display: block;
  font-size: 16px;
  min-height: 8em;
  padding: 10px;
  resize: vertical;
  width: 100%;

  .tn-mobile & {
    background-color: var(--tn-surface);
    border: 0;
    border-radius: var(--tn-radius);
    color: var(--tn-text);
    font: var(--tn-type-body);
    min-height: 10em;
    padding: var(--tn-space-4);
  }
  .tn-mobile &:focus {
    box-shadow: inset 0 0 0 2px var(--tn-accent);
    outline: none;
  }
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

  .tn-mobile & {
    gap: var(--tn-space-2) var(--tn-space-3);
    margin: var(--tn-space-4) 0 0;
  }
`

/** "One screenshot per report." beside the attach button. */
export const FeedbackAttachHint = styled.p`
  color: #666;
  font-size: 13px;
  margin: 0;

  .tn-mobile & {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
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

  .tn-mobile & {
    border: 1px solid var(--tn-border);
    border-radius: var(--tn-radius-sm);
  }
`

/**
 * Remove, on the picture it removes.
 *
 * It used to be a full-width-ish bootstrap button floating at the vertical
 * middle of a 160 px thumbnail with nothing tying the two together; on the
 * rider's screenshot it reads as an unrelated control. The button is the
 * 44 px touch target Apple asks for, centred on the tile's corner; the
 * 28 px disc it draws (::before) is what the rider sees.
 */
export const FeedbackRemoveButton = styled.button`
  align-items: center;
  background: transparent;
  border: 0;
  color: #333;
  display: flex;
  font-size: 18px;
  height: 44px;
  justify-content: center;
  line-height: 1;
  padding: 0;
  position: absolute;
  right: -16px;
  top: -16px;
  width: 44px;

  &::before {
    background: #fff;
    border: 1px solid #adadad;
    border-radius: 50%;
    content: '';
    height: 28px;
    left: 8px;
    position: absolute;
    top: 8px;
    width: 28px;
  }
  > span {
    position: relative;
  }
  &:focus {
    outline: none;
  }
  &:focus-visible::before {
    outline: 2px solid ${baseColor};
  }

  .tn-mobile & {
    color: var(--tn-text);
  }
  .tn-mobile &::before {
    background: var(--tn-surface);
    border: 0;
    box-shadow: var(--tn-shadow);
  }
  .tn-mobile &:focus-visible::before {
    outline-color: var(--tn-accent);
  }
`

/** Sent / held / failed. Never a spinner alone: the rider needs the words. */
export const FeedbackStatus = styled.p<{ $failed?: boolean }>`
  color: ${(props) => (props.$failed ? RED_ON_WHITE : '#186429')};
  font-size: 14px;
  font-weight: 700;
  margin: 1em 0 0 0;

  .tn-mobile & {
    background-color: ${(props) =>
      props.$failed ? 'var(--tn-danger-soft)' : 'var(--tn-live-soft)'};
    border-radius: var(--tn-radius-sm);
    color: ${(props) =>
      props.$failed ? 'var(--tn-danger)' : 'var(--tn-live)'};
    font: 500 14px/18px var(--tn-font);
    margin: var(--tn-space-3) 0 0;
    padding: var(--tn-space-3) var(--tn-space-4);
  }
`
