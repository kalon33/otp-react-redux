/**
 * The rider's Träwelling/travelynx settings, on the device — the same pattern
 * as the Appearance preference (util/tn-theme): a single raw localStorage key
 * written through safe-storage so a full or blocked store cannot throw.
 *
 * The tokens are secrets the rider pastes from each service's own settings
 * page; they never leave the device except to that service's API.
 */
import { readRaw, writeRaw } from './safe-storage'
import type { CheckinSettings, ServiceSettings } from './checkin'

const STORAGE_KEY = 'tn.checkin'

const emptyService: ServiceSettings = {
  enabled: false,
  token: ''
}

export const defaultCheckinSettings = (): CheckinSettings => ({
  travelynx: { ...emptyService },
  trawelling: { ...emptyService }
})

function normalizeService(raw: any): ServiceSettings {
  if (!raw || typeof raw !== 'object') return { ...emptyService }
  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    enabled: !!raw.enabled,
    token: typeof raw.token === 'string' ? raw.token : ''
  }
}

export function readCheckinSettings(): CheckinSettings {
  const defaults = defaultCheckinSettings()
  let raw: any = null
  try {
    raw = JSON.parse(readRaw(STORAGE_KEY) ?? '')
  } catch {
    // Nothing stored yet, or an unreadable value: the defaults apply.
  }
  if (!raw || typeof raw !== 'object') return defaults
  return {
    travelynx: { ...defaults.travelynx, ...normalizeService(raw.travelynx) },
    trawelling: { ...defaults.trawelling, ...normalizeService(raw.trawelling) }
  }
}

export function writeCheckinSettings(settings: CheckinSettings): void {
  writeRaw(STORAGE_KEY, JSON.stringify(settings))
}

/** True when at least one service has both a token and the rider's consent. */
export function anyCheckinConfigured(settings: CheckinSettings): boolean {
  return (
    (settings.trawelling.enabled && !!settings.trawelling.token) ||
    (settings.travelynx.enabled && !!settings.travelynx.token)
  )
}
