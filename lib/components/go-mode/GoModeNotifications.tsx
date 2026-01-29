import React, { useCallback, useEffect, useState } from 'react'
import styled, { keyframes } from 'styled-components'

interface ToastNotification {
  id: string
  message: string
  priority: 'high' | 'medium' | 'low'
  timestamp: number
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
  top: 0;
  z-index: 2000;
`

const Toast = styled.div<{ $dismissing: boolean; $priority: string }>`
  animation: ${(props) => (props.$dismissing ? slideOut : slideIn)} 0.3s
    ease-in-out forwards;
  background-color: ${(props) => {
    switch (props.$priority) {
      case 'high':
        return '#F44336'
      case 'medium':
        return '#2196F3'
      default:
        return '#757575'
    }
  }};
  border-radius: 0 0 8px 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  color: white;
  font-size: 14px;
  font-weight: 500;
  margin: 0 8px 8px;
  padding: 12px 16px;
  pointer-events: auto;
`

const AUTO_DISMISS_MS = 5000

const GoModeNotifications = () => {
  const [toasts, setToasts] = useState<ToastNotification[]>([])
  const [dismissing, setDismissing] = useState<Set<string>>(new Set())

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

  useEffect(() => {
    const handler = (event: CustomEvent<ToastNotification>) => {
      const notification = event.detail
      setToasts((prev) => [notification, ...prev])

      // Auto-dismiss after 5s
      setTimeout(() => {
        dismissToast(notification.id)
      }, AUTO_DISMISS_MS)
    }

    window.addEventListener('go-mode-notification', handler as EventListener)
    return () => {
      window.removeEventListener(
        'go-mode-notification',
        handler as EventListener
      )
    }
  }, [dismissToast])

  if (toasts.length === 0) return null

  return (
    <ToastContainer>
      {toasts.map((toast) => (
        <Toast
          $dismissing={dismissing.has(toast.id)}
          $priority={toast.priority}
          key={toast.id}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </Toast>
      ))}
    </ToastContainer>
  )
}

export default GoModeNotifications
