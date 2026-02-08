import styled, { css, keyframes } from 'styled-components'

// Shared animations
export const pulseOpacity = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.8;
  }
`

// GoModeHeader styles
export const HeaderContainer = styled.div`
  background-color: #fff;
  border-bottom: 1px solid #e0e0e0;
  padding: 12px 16px;
`

export const ProgressBarTrack = styled.div`
  background-color: #e0e0e0;
  border-radius: 4px;
  height: 8px;
  margin-bottom: 12px;
  overflow: hidden;
  width: 100%;
`

export const ProgressBarFill = styled.div<{
  $color: string
  $width: number
}>`
  background-color: ${(props) => props.$color};
  height: 100%;
  transition: width 0.3s ease;
  width: ${(props) => props.$width}%;
`

export const HeaderRow = styled.div`
  align-items: center;
  display: flex;
  justify-content: space-between;
`

export const ETAValue = styled.div`
  font-size: 24px;
  font-weight: bold;
`

export const ETALabel = styled.div`
  color: #666;
  font-size: 12px;
`

export const TimeRemainingValue = styled.div`
  font-size: 18px;
  font-weight: 500;
`

export const StatusBadge = styled.div<{ $color: string }>`
  background-color: ${(props) => props.$color};
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  margin-top: 8px;
  padding: 6px 12px;
  text-align: center;
`

// CurrentLegPanel styles
export const LegPanelContainer = styled.div`
  background-color: #fff;
  border-top: 2px solid #e0e0e0;
  flex: 0 0 auto;
  max-height: 50%;
  overflow-y: auto;
`

// TransitProgress styles
export const TransitContainer = styled.div`
  padding: 16px;
`

export const RouteHeader = styled.div`
  align-items: center;
  display: flex;
  margin-bottom: 16px;
`

export const ModeIcon = styled.span`
  font-size: 32px;
  margin-right: 12px;
`

export const RouteName = styled.div`
  font-size: 18px;
  font-weight: bold;
`

export const RouteDirection = styled.div`
  color: #666;
  font-size: 14px;
`

export const AlertBanner = styled.div<{ $severity: 'urgent' | 'warning' }>`
  animation: ${pulseOpacity} 1s ease-in-out infinite;
  background-color: ${(props) =>
    props.$severity === 'urgent' ? '#F44336' : '#FF9800'};
  border-radius: 8px;
  color: white;
  font-size: 16px;
  font-weight: bold;
  margin-bottom: 16px;
  padding: 16px;
  text-align: center;
`

export const StopsCount = styled.div<{ $alert: boolean }>`
  color: ${(props) => (props.$alert ? '#F44336' : '#2196F3')};
  font-size: 32px;
  font-weight: bold;
  text-align: center;
`

export const StopsLabel = styled.div`
  color: #666;
  font-size: 14px;
  text-align: center;
`

export const InfoCard = styled.div<{
  $bgColor?: string
  $textColor?: string
}>`
  background-color: ${(props) => props.$bgColor || '#f5f5f5'};
  border-radius: 4px;
  margin-bottom: 12px;
  padding: 12px;

  ${(props) =>
    props.$textColor &&
    css`
      color: ${props.$textColor};
    `}
`

export const InfoCardLabel = styled.div<{ $color?: string }>`
  color: ${(props) => props.$color || '#666'};
  font-size: 12px;
  margin-bottom: 4px;
`

export const InfoCardValue = styled.div<{
  $color?: string
}>`
  font-size: 16px;
  font-weight: 500;
  ${(props) =>
    props.$color &&
    css`
      color: ${props.$color};
    `}
`

// WalkingNavigation styles
export const WalkingContainer = styled.div`
  padding: 16px;
`

export const NavigationInstruction = styled.div<{ $highlight: boolean }>`
  background-color: ${(props) => (props.$highlight ? '#e3f2fd' : '#f5f5f5')};
  border-left: 4px solid
    ${(props) => (props.$highlight ? '#2196F3' : '#9e9e9e')};
  border-radius: 8px;
  margin-bottom: 16px;
  padding: 16px;
`

export const InstructionText = styled.div`
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 8px;
`

export const DistanceDisplay = styled.div`
  color: #2196f3;
  font-size: 24px;
  font-weight: bold;
`

export const NextLegPreview = styled.div`
  background-color: #fff3e0;
  border-left: 4px solid #ff9800;
  border-radius: 4px;
  padding: 12px;
`

export const CountdownCard = styled.div<{ $urgency: 'ok' | 'tight' | 'late' }>`
  background-color: ${(props) => {
    switch (props.$urgency) {
      case 'ok':
        return '#e8f5e9'
      case 'tight':
        return '#fff8e1'
      case 'late':
        return '#ffebee'
    }
  }};
  border-left: 4px solid
    ${(props) => {
      switch (props.$urgency) {
        case 'ok':
          return '#4caf50'
        case 'tight':
          return '#ff9800'
        case 'late':
          return '#f44336'
      }
    }};
  border-radius: 4px;
  margin-bottom: 12px;
  padding: 12px;
`

export const CountdownValue = styled.div<{ $urgency: 'ok' | 'tight' | 'late' }>`
  color: ${(props) => {
    switch (props.$urgency) {
      case 'ok':
        return '#2e7d32'
      case 'tight':
        return '#e65100'
      case 'late':
        return '#c62828'
    }
  }};
  font-size: 18px;
  font-weight: bold;
`

export const CountdownLabel = styled.div`
  color: #666;
  font-size: 12px;
  margin-bottom: 2px;
`

export const SmallProgressTrack = styled.div`
  background-color: #e0e0e0;
  border-radius: 3px;
  height: 6px;
  overflow: hidden;
  width: 100%;
`

export const SmallProgressFill = styled.div<{ $width: number }>`
  background-color: #4caf50;
  height: 100%;
  transition: width 0.3s ease;
  width: ${(props) => props.$width}%;
`

// GoModeMap styles
export const MapContainer = styled.div`
  flex: 1 1 40%;
  min-height: 250px;
  position: relative;
`

export const DeviationWarning = styled.div`
  background-color: #ff9800;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  color: white;
  font-size: 14px;
  font-weight: 500;
  left: 50%;
  padding: 8px 16px;
  position: absolute;
  top: 10px;
  transform: translateX(-50%);
  z-index: 1001;
`

// GoModeScreen styles
export const ScreenMain = styled.main`
  display: flex;
  flex-direction: column;
  height: calc(100vh - 50px);
  overflow: hidden;
  position: relative;
`

export const LoadingMessage = styled.main`
  padding: 20px;
  text-align: center;
`

export const ErrorMessage = styled.p`
  color: #d32f2f;
  margin-bottom: 16px;
`

export const RetryButton = styled.button`
  background-color: #2196f3;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 16px;
  padding: 12px 24px;
`

export const GpsWarningBanner = styled.div`
  background: #ff9800;
  color: white;
  padding: 10px;
  text-align: center;
`

// Dev simulation toolbar styles
export const SimToolbar = styled.div`
  background: #263238;
  border-top: 2px solid #37474f;
  bottom: 0;
  color: #eceff1;
  display: flex;
  flex-wrap: wrap;
  font-size: 12px;
  gap: 6px;
  left: 0;
  padding: 8px 12px;
  position: absolute;
  right: 0;
  z-index: 2000;
`

export const SimButton = styled.button<{
  $variant?: 'start' | 'stop' | 'pause' | 'resume'
}>`
  background-color: ${(props) => {
    switch (props.$variant) {
      case 'start':
        return '#4CAF50'
      case 'stop':
        return '#F44336'
      case 'pause':
        return '#FF9800'
      case 'resume':
        return '#2196F3'
      default:
        return '#607D8B'
    }
  }};
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;

  &:active {
    opacity: 0.8;
  }
`

export const SimSpeedSelect = styled.select`
  background: #37474f;
  border: 1px solid #546e7a;
  border-radius: 4px;
  color: #eceff1;
  font-size: 12px;
  padding: 4px 6px;
`

export const SimProgress = styled.span`
  align-items: center;
  color: #90a4ae;
  display: flex;
  font-size: 11px;
  margin-left: auto;
`

export const SimToggle = styled.button`
  background: none;
  border: none;
  color: #90a4ae;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 6px;
  position: absolute;
  right: 4px;
  top: -18px;
  z-index: 2001;

  &:hover {
    color: #eceff1;
  }
`
