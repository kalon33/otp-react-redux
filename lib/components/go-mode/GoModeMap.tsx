import React, { useEffect, useRef } from 'react'
import type { Itinerary } from '@opentripplanner/types'

import DefaultMap from '../map/default-map'
import type { RouteMatchResult } from '../../util/go-mode/position-matching'

interface Props {
  currentLegIndex: number
  currentPosition: GeolocationPosition | null
  followUser: boolean
  itinerary: Itinerary
  routeMatch: RouteMatchResult | null
}

const GoModeMap = ({
  currentLegIndex,
  currentPosition,
  followUser,
  itinerary,
  routeMatch
}: Props) => {
  const mapRef = useRef<any>(null)

  // Center map on user position when followUser is enabled
  useEffect(() => {
    if (
      followUser &&
      currentPosition &&
      mapRef.current &&
      mapRef.current.getMap
    ) {
      const map = mapRef.current.getMap()
      if (map) {
        map.panTo([
          currentPosition.coords.longitude,
          currentPosition.coords.latitude
        ])
      }
    }
  }, [currentPosition, followUser])

  return (
    <div
      style={{
        flex: '1 1 40%',
        minHeight: '250px',
        position: 'relative'
      }}
    >
      <DefaultMap ref={mapRef} />

      {/* User Position Marker */}
      {currentPosition && (
        <div
          style={{
            animation: 'pulse 2s infinite',
            backgroundColor: '#2196F3',
            border: '3px solid white',
            borderRadius: '50%',
            boxShadow: '0 0 10px rgba(33, 150, 243, 0.5)',
            height: '20px',
            left: '50%',
            position: 'absolute',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '20px',
            zIndex: 1000
          }}
        />
      )}

      {/* Deviation Warning */}
      {routeMatch && !routeMatch.isOnRoute && (
        <div
          style={{
            backgroundColor: '#FF9800',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            color: 'white',
            fontSize: '14px',
            fontWeight: '500',
            left: '50%',
            padding: '8px 16px',
            position: 'absolute',
            top: '10px',
            transform: 'translateX(-50%)',
            zIndex: 1001
          }}
        >
          {Math.round(routeMatch.distanceFromRoute)}m from route
        </div>
      )}

      {/* CSS for pulse animation */}
      <style>
        {`
        @keyframes pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(33, 150, 243, 0.7);
          }
          70% {
            box-shadow: 0 0 0 15px rgba(33, 150, 243, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(33, 150, 243, 0);
          }
        }
      `}
      </style>
    </div>
  )
}

export default GoModeMap
