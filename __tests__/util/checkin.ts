import {
  checkinLeg,
  travelynxCheckin,
  trawellingCheckin
} from '../../lib/util/checkin'

/**
 * The Träwelling flow against the CURRENT v1 contract
 * (https://traewelling.de/docs?api-docs.json, MOTIS backend): station
 * autocomplete → /v1/station/{id}/departures → /v1/trains/trip
 * (hafasTripId + lineName) → /v1/trains/checkin with the trip's INTERNAL
 * tripId, the two STATION ids and the trip's own planned stopover times.
 * These tests pin every URL and payload shape, because the previous
 * implementation silently called the pre-MOTIS endpoints and every
 * check-in failed.
 */

const TOKEN = 'test-token'

const json = (body: any, ok = true) => ({
  json: async () => body,
  ok,
  status: ok ? 200 : 400
})

const TRAWELLING = { enabled: true, token: TOKEN }
const TRAVELYNX = { enabled: true, token: '12-abc' }

const leg = {
  from: { name: 'Essen Hbf' },
  mode: 'RAIL',
  routeShortName: 'RE 1',
  startTime: 1734000000000,
  to: { name: 'Bochum Hbf' }
}

describe('util > checkin > Träwelling flow', () => {
  let calls: { init?: RequestInit; url: string }[] = []
  let tripUrls: string[] = []

  beforeEach(() => {
    calls = []
    tripUrls = []
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      calls.push({ init, url })
      if (url.includes('/v1/trains/station/autocomplete/')) {
        return Promise.resolve(json({ data: [{ id: 42, name: 'Essen Hbf' }] }))
      }
      if (url.includes('/v1/station/42/departures')) {
        return Promise.resolve(
          json({
            data: [
              {
                cancelled: true,
                line: { name: 'RE 1' },
                plannedWhen: new Date(1734000000000).toISOString(),
                tripId: 'wrong|cancelled'
              },
              {
                cancelled: false,
                line: { name: 'RE 1' },
                plannedWhen: new Date(1734000000000).toISOString(),
                tripId: '1|200513|0|81|6012023'
              }
            ]
          })
        )
      }
      if (url.includes('/v1/trains/trip')) {
        tripUrls.push(url)
        return Promise.resolve(
          json({
            data: {
              lineName: 'RE 1',
              stopovers: [
                {
                  arrivalPlanned: '2024-12-12T09:00:00+00:00',
                  departurePlanned: '2024-12-12T09:05:00+00:00',
                  station: { id: 42, name: 'Essen Hbf' }
                },
                {
                  arrivalPlanned: '2024-12-12T09:20:00+00:00',
                  departurePlanned: '2024-12-12T09:22:00+00:00',
                  station: { id: 43, name: 'Bochum Hbf' }
                }
              ],
              tripId: 'internal-trip-uuid'
            }
          })
        )
      }
      if (url.includes('/v1/trains/checkin')) {
        return Promise.resolve(json({ data: { status: { id: 7 } } }, true))
      }
      throw new Error(`unexpected URL ${url}`)
    })
  })

  it('follows autocomplete → departures → trip → checkin', async () => {
    const result = await trawellingCheckin(
      { ...TRAWELLING, baseUrl: 'https://traewelling.de/api' } as any,
      leg as any
    )
    expect(result.ok).toBe(true)
    expect(result.statusId).toBe('7')
    expect(calls[0].url).toContain(
      '/v1/trains/station/autocomplete/Essen%20Hbf'
    )
    expect(calls[1].url).toContain('/v1/station/42/departures?when=')
    expect(calls[2].url).toContain('/v1/trains/trip?')
    expect(calls[3].url).toContain('/v1/trains/checkin')
    expect(tripUrls[0]).toContain('hafasTripId=1%7C200513%7C0%7C81%7C6012023')
    expect(tripUrls[0]).toContain('lineName=RE%201')
  })

  it('sends the internal trip id, the station ids and the trip times', async () => {
    await trawellingCheckin(
      { ...TRAWELLING, baseUrl: 'https://traewelling.de/api' } as any,
      leg as any
    )
    const body = JSON.parse(String(calls[3].init?.body))
    expect(body).toEqual({
      arrival: '2024-12-12T09:20:00+00:00',
      departure: '2024-12-12T09:05:00+00:00',
      destination: 43,
      lineName: 'RE 1',
      start: 42,
      tripId: 'internal-trip-uuid'
    })
  })

  it('carries the token as a Bearer header on every call', async () => {
    await trawellingCheckin(
      { ...TRAWELLING, baseUrl: 'https://traewelling.de/api' } as any,
      leg as any
    )
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('reports an unknown station instead of checking in', async () => {
    global.fetch = jest.fn(() => Promise.resolve(json({ data: [] })))
    const result = await trawellingCheckin(
      { ...TRAWELLING, baseUrl: 'https://traewelling.de/api' } as any,
      leg as any
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Essen Hbf')
  })

  it('refuses a leg without stop names', async () => {
    const result = await trawellingCheckin(
      TRAWELLING as any,
      { from: {}, to: {} } as any
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no stop names')
  })

  it('reports when no departure of that line matches the leg', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url.includes('autocomplete')) {
        return Promise.resolve(json({ data: [{ id: 42 }] }))
      }
      return Promise.resolve(
        json({
          data: [
            {
              line: { name: 'RB 99' },
              plannedWhen: new Date(1734000000000).toISOString(),
              tripId: 'other'
            }
          ]
        })
      )
    })
    const result = await trawellingCheckin(TRAWELLING as any, leg as any)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No RE 1 departure from Essen Hbf')
  })

  it('reports when the destination is not on the trip found', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url.includes('autocomplete')) {
        return Promise.resolve(json({ data: [{ id: 42 }] }))
      }
      if (url.includes('/v1/station/')) {
        return Promise.resolve(
          json({
            data: [
              {
                line: { name: 'RE 1' },
                plannedWhen: new Date(1734000000000).toISOString(),
                tripId: 'motis-trip'
              }
            ]
          })
        )
      }
      if (url.includes('/v1/trains/trip')) {
        return Promise.resolve(
          json({
            data: {
              lineName: 'RE 1',
              stopovers: [
                {
                  arrivalPlanned: '2024-12-12T09:00:00+00:00',
                  departurePlanned: '2024-12-12T09:05:00+00:00',
                  station: { id: 42, name: 'Essen Hbf' }
                }
              ],
              tripId: 'internal-trip-uuid'
            }
          })
        )
      }
      throw new Error('checkin must not be reached')
    })
    const result = await trawellingCheckin(TRAWELLING as any, leg as any)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not part of the RE 1 journey')
  })

  it('surfaces the service error text when the checkin is refused', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url.includes('autocomplete')) {
        return Promise.resolve(json({ data: [{ id: 42 }] }))
      }
      if (url.includes('/v1/station/')) {
        return Promise.resolve(
          json({
            data: [
              {
                line: { name: 'RE 1' },
                plannedWhen: new Date(1734000000000).toISOString(),
                tripId: 'motis-trip'
              }
            ]
          })
        )
      }
      if (url.includes('/v1/trains/trip')) {
        return Promise.resolve(
          json({
            data: {
              lineName: 'RE 1',
              stopovers: [
                {
                  arrivalPlanned: '2024-12-12T09:00:00+00:00',
                  departurePlanned: '2024-12-12T09:05:00+00:00',
                  station: { id: 42, name: 'Essen Hbf' }
                },
                {
                  arrivalPlanned: '2024-12-12T09:20:00+00:00',
                  departurePlanned: '2024-12-12T09:22:00+00:00',
                  station: { id: 43, name: 'Bochum Hbf' }
                }
              ],
              tripId: 'internal-trip-uuid'
            }
          })
        )
      }
      // A collision with an existing status, as Träwelling answers it.
      return Promise.resolve(
        json({ message: 'You are already checked in on this trip.' }, false)
      )
    })
    const result = await trawellingCheckin(TRAWELLING as any, leg as any)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already checked in')
  })
})

describe('util > checkin > travelynx', () => {
  it('posts the token, train and station names to /api/v1/travel', async () => {
    const calls: { init?: RequestInit; url: string }[] = []
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      calls.push({ init, url })
      return Promise.resolve(json({ success: true }))
    })
    const result = await travelynxCheckin(TRAVELYNX as any, leg as any)
    expect(result.ok).toBe(true)
    expect(calls[0].url).toBe('https://travelynx.de/api/v1/travel')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      action: 'checkin',
      fromStation: 'Essen Hbf',
      token: '12-abc',
      toStation: 'Bochum Hbf',
      train: { no: 'RE 1', type: 'RE' }
    })
  })

  it('reports the service error text on failure', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(json({ error: 'Invalid token', success: false }, false))
    )
    const result = await travelynxCheckin(TRAVELYNX as any, leg as any)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Invalid token')
  })

  it('falls back to a no-cors send when the browser blocks the answer', async () => {
    const calls: { init?: RequestInit; url: string }[] = []
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      calls.push({ init, url })
      if (calls.length === 1) {
        // The first attempt is blocked by the browser (no CORS headers on
        // travelynx's side): fetch rejects without reaching a response.
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve({ ok: true, status: 0, type: 'opaque' } as any)
    })
    const result = await travelynxCheckin(TRAVELYNX as any, leg as any)
    expect(result.ok).toBe(true)
    expect(result.sent).toBe(true)
    expect(calls[1].init?.mode as string).toBe('no-cors')
  })
})

describe('util > checkin > checkinLeg', () => {
  it('checks into only the enabled service', async () => {
    const urls: string[] = []
    global.fetch = jest.fn((url: string) => {
      urls.push(String(url))
      return Promise.resolve(json({ success: true }))
    })
    const results = await checkinLeg(
      {
        travelynx: TRAVELYNX,
        trawelling: { enabled: false, token: '' }
      } as any,
      leg as any
    )
    expect(Object.keys(results)).toEqual(['travelynx'])
    expect(urls.every((u) => u.includes('travelynx.de'))).toBe(true)
  })

  it('checks into both enabled services in parallel', async () => {
    const urls: string[] = []
    global.fetch = jest.fn((url: string) => {
      urls.push(String(url))
      if (String(url).includes('traewelling')) {
        if (String(url).includes('autocomplete')) {
          return Promise.resolve(json({ data: [{ id: 1 }] }))
        }
        if (String(url).includes('/v1/station/')) {
          return Promise.resolve(
            json({
              data: [
                {
                  line: { name: 'RE 1' },
                  plannedWhen: new Date(1734000000000).toISOString(),
                  tripId: 'motis-trip'
                }
              ]
            })
          )
        }
        if (String(url).includes('/v1/trains/trip')) {
          return Promise.resolve(
            json({
              data: {
                lineName: 'RE 1',
                stopovers: [
                  {
                    arrivalPlanned: '2024-12-12T09:00:00+00:00',
                    departurePlanned: '2024-12-12T09:05:00+00:00',
                    station: { id: 1, name: 'Essen Hbf' }
                  },
                  {
                    arrivalPlanned: '2024-12-12T09:20:00+00:00',
                    departurePlanned: '2024-12-12T09:22:00+00:00',
                    station: { id: 2, name: 'Bochum Hbf' }
                  }
                ],
                tripId: 'internal-trip-uuid'
              }
            })
          )
        }
        return Promise.resolve(json({ data: { status: { id: 7 } } }))
      }
      return Promise.resolve(json({ success: true }))
    })
    const results = await checkinLeg(
      {
        travelynx: TRAVELYNX,
        trawelling: TRAWELLING
      } as any,
      leg as any
    )
    expect(Object.keys(results).sort()).toEqual(['travelynx', 'trawelling'])
    expect(results.trawelling?.ok).toBe(true)
    expect(results.travelynx?.ok).toBe(true)
  })
})
