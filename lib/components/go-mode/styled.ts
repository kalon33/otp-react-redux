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
  min-width: 0;
  overflow: hidden;
`

export const ETAValue = styled.div<{ $color?: string }>`
  color: ${(props) => props.$color || 'inherit'};
  font-size: 24px;
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const ETALabel = styled.div`
  color: #666;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border-bottom: 1px solid #e0e0e0;
  flex: 0 0 auto;
  max-height: 50%;
  overflow-y: auto;
`

// TransitProgress styles
export const TransitContainer = styled.div`
  padding: 8px 12px;
`

export const RouteHeader = styled.div`
  align-items: center;
  display: flex;
  margin-bottom: 16px;
  min-width: 0;
  overflow: hidden;
`

export const ModeIcon = styled.span`
  font-size: 32px;
  margin-right: 12px;
`

export const RouteName = styled.div`
  font-size: 18px;
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const RouteDirection = styled.div`
  color: #666;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  overflow-wrap: break-word;
  padding: 16px;
  text-align: center;
  word-wrap: break-word;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  ${(props) =>
    props.$color &&
    css`
      color: ${props.$color};
    `}
`

// WalkingNavigation styles
export const WalkingContainer = styled.div`
  padding: 8px 12px;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

// --- Single adaptive navigation card (access leg → transit) ---------------
// One flat card replaces the old stacked banner + instruction row + countdown
// box. Urgency is shown by the hero color + a thin top accent only — no nested
// colored boxes. $urgency: ok (green) / tight (amber) / late (red).
const urgencyAccent = (u: 'ok' | 'tight' | 'late') =>
  u === 'late' ? '#f44336' : u === 'tight' ? '#ff9800' : '#4caf50'
const urgencyText = (u: 'ok' | 'tight' | 'late') =>
  u === 'late' ? '#c62828' : u === 'tight' ? '#e65100' : '#2e7d32'

export const NavCard = styled.div<{ $urgency: 'ok' | 'tight' | 'late' }>`
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 10px;
  border-top: 4px solid ${(props) => urgencyAccent(props.$urgency)};
  padding: 14px 16px;
`

export const NavEyebrow = styled.div`
  color: #888;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
`

export const NavHero = styled.div<{ $urgency: 'ok' | 'tight' | 'late' }>`
  color: ${(props) => urgencyText(props.$urgency)};
  font-size: 34px;
  font-weight: 700;
  line-height: 1.1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const NavSub = styled.div`
  color: #333;
  font-size: 15px;
  font-weight: 500;
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const NavFoot = styled.div`
  color: #666;
  font-size: 13px;
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

// Secondary strip at the card bottom for rare controls (alternate departures,
// reset-to-planned). Only rendered when relevant.
export const NavExtras = styled.div`
  border-top: 1px solid #eee;
  margin-top: 10px;
  padding-top: 8px;
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

// Alternative departure styles
export const AlternativeDeparture = styled.div`
  align-items: center;
  border-top: 1px dashed #ccc;
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  min-width: 0;
  overflow: hidden;
  padding-top: 8px;
`

export const UseNextButton = styled.button`
  background-color: #2196f3;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  margin-left: 8px;
  padding: 6px 10px;

  &:active {
    opacity: 0.8;
  }
`

export const ResetButton = styled.button`
  background: none;
  border: none;
  color: #2196f3;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  text-decoration: underline;

  &:active {
    opacity: 0.7;
  }
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
  max-width: calc(100% - 20px);
  overflow-wrap: break-word;
  padding: 8px 16px;
  position: absolute;
  top: 10px;
  transform: translateX(-50%);
  word-wrap: break-word;
  z-index: 1001;
`

// GoModeScreen styles
export const FullScreenWrapper = styled.div`
  background: #fff;
  bottom: 0;
  left: 0;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 1000;

  /* MobileNavigationBar renders outside .otp context, so its CSS won't apply */
  .navbar .mobile-header {
    align-items: center;
    display: flex;
    flex: 1;
    height: 100%;
    justify-content: center;
    overflow: hidden;
    padding: 0 8px;
    text-align: center;
  }

  .mobile-header-text {
    color: #333;
    font-size: 14px !important;
    font-weight: 400;
    line-height: 1.1;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }
`

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
  overflow-wrap: break-word;
  padding: 10px;
  text-align: center;
  word-wrap: break-word;
`

// Live re-route (Go Mode) styles
export const RerouteBar = styled.div`
  bottom: 12px;
  left: 12px;
  position: absolute;
  right: 12px;
  z-index: 1100;
`

export const RerouteButton = styled.button`
  background: #fff;
  border: 1px solid #2196f3;
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  color: #2196f3;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  padding: 10px 16px;
  width: 100%;
`

export const RerouteCard = styled.div`
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  padding: 14px 16px;
`

export const RerouteCardTitle = styled.div`
  color: #333;
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 4px;
`

export const RerouteSummary = styled.div`
  color: #555;
  font-size: 14px;
  margin-bottom: 12px;
`

export const RerouteActions = styled.div`
  display: flex;
  gap: 8px;
`

export const RerouteSwitchButton = styled.button`
  background: #2196f3;
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  padding: 10px;
`

export const RerouteKeepButton = styled.button`
  background: #f1f1f1;
  border: none;
  border-radius: 6px;
  color: #333;
  cursor: pointer;
  flex: 1;
  font-size: 14px;
  padding: 10px;
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

// Boarding prompt styles
const slideUp = keyframes`
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
`

export const BoardingOverlay = styled.div`
  background: rgba(0, 0, 0, 0.4);
  bottom: 0;
  left: 0;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 3000;
`

export const BoardingSheet = styled.div`
  animation: ${slideUp} 0.3s ease-out;
  background: #fff;
  border-radius: 16px 16px 0 0;
  bottom: 0;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
  left: 0;
  max-height: 70vh;
  overflow-y: auto;
  padding: 20px 16px;
  position: fixed;
  right: 0;
  z-index: 3001;
`

export const BoardingTitle = styled.h3`
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px;
`

export const BoardingSubtitle = styled.p`
  color: #666;
  font-size: 14px;
  margin: 0 0 16px;
`

export const VehicleOptionRow = styled.div`
  align-items: center;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 12px;
`

export const VehicleInfo = styled.div`
  flex: 1;
  min-width: 0;
`

export const VehicleLabel = styled.div`
  font-size: 16px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const VehicleDetail = styled.div`
  color: #666;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const VehicleSelectButton = styled.button`
  background-color: #4caf50;
  border: none;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 500;
  margin-left: 12px;
  padding: 8px 16px;

  &:active {
    opacity: 0.8;
  }
`

export const BoardingDismissButton = styled.button`
  background: none;
  border: 1px solid #ccc;
  border-radius: 8px;
  color: #666;
  cursor: pointer;
  font-size: 14px;
  margin-top: 8px;
  padding: 10px;
  width: 100%;

  &:active {
    background: #f5f5f5;
  }
`

// Vehicle tracking badge for TransitProgress
export const VehicleTrackingBadge = styled.div<{ $confirmed: boolean }>`
  align-items: center;
  background-color: ${(props) => (props.$confirmed ? '#e8f5e9' : '#e3f2fd')};
  border-radius: 12px;
  color: ${(props) => (props.$confirmed ? '#2e7d32' : '#1565c0')};
  display: inline-flex;
  font-size: 12px;
  font-weight: 500;
  margin-top: 4px;
  padding: 2px 10px;
`

export const LocatingIndicator = styled.div`
  animation: ${pulseOpacity} 1.5s ease-in-out infinite;
  color: #999;
  font-size: 13px;
  margin-top: 4px;
`

// Mid-trip re-route quick chips + typed message
export const RerouteChips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
`

export const RerouteChip = styled.button`
  background: #f1f1f1;
  border: 1px solid #ccc;
  border-radius: 999px;
  color: #333;
  cursor: pointer;
  font-size: 13px;
  padding: 6px 12px;
`

export const RerouteNlRow = styled.div`
  display: flex;
  gap: 6px;
`

export const RerouteNlInput = styled.input`
  border: 1px solid #ccc;
  border-radius: 6px;
  flex: 1;
  font: inherit;
  min-width: 0;
  padding: 8px;
`

export const RerouteSendButton = styled.button`
  background: #2196f3;
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-weight: 600;
  padding: 8px 14px;

  &:disabled {
    opacity: 0.6;
  }
`

export const RerouteNlError = styled.div`
  color: #d32f2f;
  font-size: 12px;
  margin-top: 6px;
`
