import { getNetwork } from '@opentripplanner/map-popup/lib/util'
import { IntlProvider } from 'react-intl'
import MapPopup from '@opentripplanner/map-popup'
import React from 'react'
import ReactDOM from 'react-dom'

import { MapLayerErrorBoundary } from '../../../lib/components/util/error-boundary'
import { recordedSessionEvents } from '../../test-utils/mock-data/debug-log'

// 2026-09-04, bundle 2026.0904.1, ~01:53Z, 50 seconds into a live Go Mode trip:
// the rider tapped a bus stop on the map and the app went to a blank white
// screen. The sink recorded
//   TypeError: undefined is not an object (evaluating 's?.rentalNetwork.networkId')
// from inside a React render.
//
// The mechanism, end to end:
//
//   @opentripplanner/otp2-tile-overlay's default click handler synthesises the
//   popup entity from the tile feature's properties and then unconditionally
//   ASSIGNS `rentalNetwork` (lib/index.js):
//       synthesizedEntity.rentalNetwork =
//         "network" in synthesizedEntity ? { networkId: … } : undefined;
//   A stop tile carries no `network` property (verified against the house OTP:
//   .../vectorTiles/stops,stations/14/3946/5897.pbf has gtfsId, name, code,
//   desc, routes and no `network`), so the value is `undefined` — but assigning
//   `undefined` still CREATES the key. @opentripplanner/map-popup then gates on
//   key presence, not on the value:
//       "rentalNetwork" in entity && (… entity?.rentalNetwork.networkId …)
//   which is true for every tapped stop, and `.networkId` throws.
//
// So this was not a rare data shape: every stop tap through the otp2 stops
// layer (live since OTA 2026.0903.1) hit it. Two patches guard it — the
// overlay stops creating the key, and map-popup stops trusting its presence —
// and MapLayerErrorBoundary makes any future popup exception cost one overlay
// instead of the whole app.

/** The entity @opentripplanner/otp2-tile-overlay hands MapPopup for a stop. */
const stopEntityFromTile = (overrides) => ({
  code: '17045',
  gtfsId: 'MetroTransit:17045',
  id: 'MetroTransit:17045',
  lat: 44.9483,
  lon: -93.2878,
  name: '31st St W & Blaisdell / Nicollet',
  // Set by the overlay's click handler; the key is present, the value is not.
  rentalNetwork: undefined,
  routes: '[{"gtfsType":3},{"gtfsType":3}]',
  sourceLayer: 'stops',
  vehicleType: undefined,
  ...overrides
})

function renderIntoDom(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  ReactDOM.render(
    <IntlProvider locale="en-US" messages={{}}>
      {element}
    </IntlProvider>,
    container
  )
  const html = container.innerHTML
  ReactDOM.unmountComponentAtNode(container)
  container.remove()
  return html
}

describe('map > stop popup with no rental network', () => {
  it('renders the popup for a stop whose rentalNetwork key is undefined', () => {
    // Fails before the patch with
    // "TypeError: Cannot read properties of undefined (reading 'networkId')".
    let html
    expect(() => {
      html = renderIntoDom(
        <MapPopup configCompanies={[]} entity={stopEntityFromTile()} />
      )
    }).not.toThrow()
    // The repo's jest config maps i18n/*.yml to an empty object, so
    // FormattedMessage renders message ids rather than English strings.
    expect(html).toContain('otpUi.MapPopup.popupTitle')
    expect(getNetwork(stopEntityFromTile(), [])).toBe(false)
  })

  it('renders the popup for a stop whose rentalNetwork key is null', () => {
    const entity = stopEntityFromTile({ rentalNetwork: null })
    let html
    expect(() => {
      html = renderIntoDom(<MapPopup configCompanies={[]} entity={entity} />)
    }).not.toThrow()
    expect(html).toContain('otpUi.MapPopup.popupTitle')
    expect(getNetwork(entity, [])).toBe(false)
  })

  it('renders the popup for a rental station that does have a network', () => {
    // The guard must not swallow the case the code was written for.
    const companies = [{ id: 'NICE_RIDE', label: 'Nice Ride' }]
    const station = {
      availableSpaces: { total: 4 },
      availableVehicles: { total: 3 },
      id: 'nice-ride-1',
      lat: 44.95,
      lon: -93.28,
      name: 'Lake St Station',
      rentalNetwork: { networkId: 'NICE_RIDE' }
    }
    const html = renderIntoDom(
      <MapPopup configCompanies={companies} entity={station} />
    )
    // Station hub rows still render, and the network label still resolves.
    expect(html).toContain('otpUi.MapPopup.availableBikes')
    expect(getNetwork(station, companies)).toBe('Nice Ride')
  })
})

describe('map > the tile overlay does not invent a rentalNetwork key', () => {
  // Mirrors the assignment in @opentripplanner/otp2-tile-overlay's
  // defaultClickHandler, so a future bump of that dependency that reverts the
  // patch is caught here rather than by the rider.
  it('leaves the key off a stop feature entirely', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const overlaySource = require('fs').readFileSync(
      require.resolve('@opentripplanner/otp2-tile-overlay/lib/index.js'),
      'utf-8'
    )
    // The unpatched form assigns `undefined`, which creates the key.
    expect(overlaySource).not.toContain(
      'synthesizedEntity.rentalNetwork =\n            "network" in synthesizedEntity'
    )
    expect(overlaySource).toContain('delete synthesizedEntity.rentalNetwork')
  })
})

describe('map > MapLayerErrorBoundary', () => {
  const Boom = () => {
    throw new Error('popup blew up')
  }

  beforeEach(() => {
    recordedSessionEvents.length = 0
  })

  it('keeps a throwing overlay from unmounting everything around it', () => {
    // Before this boundary existed there was nothing between a popup exception
    // and the root: lib/app.js used React.Fragment when no Bugsnag key is set.
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const html = renderIntoDom(
        <div>
          <MapLayerErrorBoundary id="stops" name="Stops">
            <Boom />
          </MapLayerErrorBoundary>
          <span>rest of the map</span>
        </div>
      )
      expect(html).toContain('rest of the map')
      // And the exception reaches the debug-log sink rather than vanishing.
      expect(
        recordedSessionEvents.filter(
          (e) => e.event === 'render-error' && e.label === 'Stops'
        ).length
      ).toBeGreaterThan(0)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('renders its children when nothing throws', () => {
    const html = renderIntoDom(
      <MapLayerErrorBoundary id="stops" name="Stops">
        <span>stops layer</span>
      </MapLayerErrorBoundary>
    )
    expect(html).toContain('stops layer')
  })
})
