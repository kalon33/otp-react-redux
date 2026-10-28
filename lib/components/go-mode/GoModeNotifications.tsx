import { connect } from 'react-redux'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import styled, { keyframes } from 'styled-components'

import type { NotificationEvent } from '../../util/go-mode/notification-service'

interface ToastNotification {
  id: string
  message: string
  priority: 'high' | 'medium' | 'low'
  timestamp: Date
}

const slideIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(-100%);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`

const slideOut = keyframes`
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(-100%);
  }
`

const ToastContainer = styled.div`
  left: 0;
  pointer-events: none;
  position: absolute;
  right: 0;
  top: var(--tn-safe-top);
  z-index: 2000;
`

// A toast is a surface card dropped from the top edge, its priority carried
// by the left stripe (danger / accent / tertiary) rather than a solid fill, so
// it reads the same in both themes.
export const NotificationToast = styled.div<{
  $dismissing: boolean
  $priority: string
}>`
  animation: ${(props) => (props.$dismissing ? slideOut : slideIn)} 0.3s
    ease-in-out forwards;
  background-color: var(--tn-surface);
  border-radius: var(--tn-radius);
  box-shadow: inset 4px 0 0
      ${(props) => {
        switch (props.$priority) {
          case 'high':
            return 'var(--tn-danger)'
          case 'medium':
            return 'var(--tn-accent)'
          default:
            return 'var(--tn-text-3)'
        }
      }},
    var(--tn-shadow);
  color: var(--tn-text);
  font: 600 15px/20px var(--tn-font);
  margin: 8px 12px 0;
  overflow-wrap: break-word;
  padding: 12px 16px 12px 20px;
  pointer-events: auto;
  word-wrap: break-word;
`

const AUTO_DISMISS_MS = 5000

interface Props {
  recentNotifications: NotificationEvent[]
}

const GoModeNotifications = ({ recentNotifications }: Props) => {
  const [toasts, setToasts] = useState<ToastNotification[]>([])
  const [dismissing, setDismissing] = useState<Set<string>>(new Set())
  const seenIdsRef = useRef<Set<string>>(new Set())

  const dismissToast = useCallback((id: string) => {
    setDismissing((prev) => new Set(prev).add(id))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      setDismissing((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 300)
  }, [])

  // Watch Redux state for new notifications
  useEffect(() => {
    if (!recentNotifications || recentNotifications.length === 0) return

    const newest = recentNotifications[0]
    if (seenIdsRef.current.has(newest.id)) return

    seenIdsRef.current.add(newest.id)
    const toast: ToastNotification = {
      id: newest.id,
      message: newest.message,
      priority: newest.priority,
      timestamp: newest.timestamp
    }
    setToasts((prev) => [toast, ...prev])

    // Auto-dismiss after 5s
    setTimeout(() => {
      dismissToast(toast.id)
    }, AUTO_DISMISS_MS)
  }, [recentNotifications, dismissToast])

  if (toasts.length === 0) return null

  return (
    <ToastContainer>
      {toasts.map((toast) => (
        <NotificationToast
          $dismissing={dismissing.has(toast.id)}
          $priority={toast.priority}
          key={toast.id}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </NotificationToast>
      ))}
    </ToastContainer>
  )
}

const mapStateToProps = (state: any) => ({
  recentNotifications:
    state.otp?.goMode?.notifications?.recentNotifications || []
})

export default connect(mapStateToProps)(GoModeNotifications)
