import { useIntl } from 'react-intl'
import React, { useEffect, useState } from 'react'
import styled from 'styled-components'

import {
  getUnreachableSince,
  isServerReachable,
  onReachabilityChange
} from '../../util/server-reachable'

/**
 * "Can't reach the server" — said plainly, instead of a spinner forever.
 *
 * The 2026-08-14 outage lasted four days and looked, from the phone, exactly
 * like the app being slow: every request hung, nothing failed visibly, and the
 * rider had no way to tell a dead connection from a thinking one. This is the
 * difference between a mystery and a fact.
 *
 * Deliberately plain about what it does NOT know: the app cannot tell whether
 * the phone lost signal or the server went away, so it does not guess. It says
 * what is true — no answer is coming — and leaves the diagnosis alone.
 */
const Bar = styled.div`
  align-items: center;
  background: #8a2e14;
  color: #fff;
  display: flex;
  font-size: 13px;
  gap: 8px;
  justify-content: center;
  left: 0;
  line-height: 1.35;
  padding: 7px 14px;
  position: fixed;
  right: 0;
  text-align: center;
  /* Above the map and the sheets, below any modal that needs a decision. */
  top: 0;
  z-index: 1200;
`

const Dot = styled.span`
  animation: pulse 2s ease-in-out infinite;
  background: #ffb4a1;
  border-radius: 50%;
  flex: none;
  height: 8px;
  width: 8px;

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

function minutesSince(sinceMs: number | null): number {
  if (!sinceMs) return 0
  return Math.floor((Date.now() - sinceMs) / 60000)
}

const ServerUnreachableBanner = (): JSX.Element | null => {
  const intl = useIntl()
  const [reachable, setReachable] = useState(isServerReachable())
  const [, setTick] = useState(0)

  useEffect(() => onReachabilityChange(setReachable), [])

  // Re-render once a minute so the duration stays honest while it is showing.
  useEffect(() => {
    if (reachable) return undefined
    const id = setInterval(() => setTick((n) => n + 1), 60000)
    return () => clearInterval(id)
  }, [reachable])

  if (reachable) return null

  const mins = minutesSince(getUnreachableSince())

  return (
    <Bar role="status">
      <Dot />
      <span>
        {mins >= 1
          ? intl.formatMessage(
              {
                defaultMessage:
                  "Can't reach the server — no answer for {minutes} min. Trips and search are unavailable.",
                id: 'components.ServerUnreachable.forMinutes'
              },
              { minutes: mins }
            )
          : intl.formatMessage({
              defaultMessage:
                "Can't reach the server. Trips and search are unavailable.",
              id: 'components.ServerUnreachable.now'
            })}
      </span>
    </Bar>
  )
}

export default ServerUnreachableBanner
