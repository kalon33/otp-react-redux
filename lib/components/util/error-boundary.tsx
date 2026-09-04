import React, { Component, ErrorInfo, ReactNode } from 'react'

import { recordSessionEvent } from '../../util/debug-log'

/**
 * Error boundaries, because on 2026-09-04 the app did not have one.
 *
 * The rider tapped a bus stop on the map 50 seconds into a live trip and
 * `@opentripplanner/map-popup` threw
 * `TypeError: undefined is not an object (evaluating 's?.rentalNetwork.networkId')`
 * during render. `lib/app.js` only builds a real boundary when a Bugsnag key is
 * configured (`bugsnagApiKey ? Bugsnag…createErrorBoundary(React) :
 * React.Fragment`), and this deployment has no key — so React unmounted the
 * whole tree and the rider was left with a white screen in the middle of a
 * ride, with no way back other than force-quitting the app.
 *
 * Two boundaries here, at two different altitudes:
 *
 * - `MapLayerErrorBoundary` wraps one map overlay. A popup that throws is
 *   *recoverable*: the exception comes from state held inside the overlay (the
 *   clicked entity), so remounting the subtree clears the popup and the layer
 *   comes back. It retries a bounded number of times and then gives up on that
 *   one layer, leaving the rest of the map alone.
 * - `AppErrorBoundary` is the backstop under `lib/app.js`. It cannot know what
 *   broke, so it shows a message and a reload button instead of a white screen.
 *
 * Both report through the existing debug-log sink (best-effort, consent-gated,
 * never throws), so the next occurrence arrives in
 * `/home/rwt/otp-debug-logs/*.jsonl` as a `kind: "session"` entry rather than
 * only as a console capture.
 */

/** How many times a map layer may be remounted before we stop trying. */
export const MAX_LAYER_REMOUNTS = 3

/** Report a caught render error to the debug-log sink. Never throws. */
export function reportBoundaryError(
  boundary: string,
  label: string,
  error: Error,
  info?: ErrorInfo
): void {
  try {
    recordSessionEvent('render-error', {
      boundary,
      componentStack: info?.componentStack?.slice(0, 2000),
      label,
      message: String(error?.message ?? error),
      stack: error?.stack?.slice(0, 2000)
    })
  } catch (e) {
    // The sink is diagnostics: it must never turn a recoverable render error
    // into an unrecoverable one.
  }
}

interface MapLayerBoundaryProps {
  /** Passed through untouched: @opentripplanner/base-map reads it off the child
   * element's props to build the layer selector. */
  alwaysShow?: boolean
  children: ReactNode
  id?: string
  /** Human-readable name for the log line (and for base-map's layer list). */
  name?: string
  visible?: boolean
}

interface MapLayerBoundaryState {
  attempts: number
  /** True between the throw and the remount: render nothing. */
  caught: boolean
  /** Set once we have given up: the layer renders nothing from then on. */
  failed: boolean
  remountKey: number
}

/**
 * Keeps one map overlay's render exception inside that overlay.
 *
 * NOTE on the props: `@opentripplanner/base-map` decides which layers are
 * toggleable by reading `child.props.id`, `.name`, `.visible` and `.alwaysShow`
 * off its direct children (`lib/index.js`, the `toggleableLayers` filter). It
 * looks at props only, never at the component type, so a wrapper that carries
 * the same four props keeps the layer selector working.
 */
export class MapLayerErrorBoundary extends Component<
  MapLayerBoundaryProps,
  MapLayerBoundaryState
> {
  constructor(props: MapLayerBoundaryProps) {
    super(props)
    this.state = { attempts: 0, caught: false, failed: false, remountKey: 0 }
  }

  // Stop rendering the broken subtree in the SAME commit as the throw. Without
  // this React re-renders the same children immediately and rethrows, and the
  // exception escapes the boundary. componentDidCatch below then decides, with
  // the attempt count to hand, between remounting and giving up.
  static getDerivedStateFromError(): Partial<MapLayerBoundaryState> {
    return { caught: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.name || this.props.id || 'map layer'
    reportBoundaryError('map-layer', label, error, info)
    const attempts = this.state.attempts + 1
    if (attempts <= MAX_LAYER_REMOUNTS) {
      // Remount the subtree with a fresh key. The overlay's popup state lives
      // in its own useState, so the entity that threw is gone and the layer
      // itself comes back.
      this.setState({
        attempts,
        caught: false,
        failed: false,
        remountKey: this.state.remountKey + 1
      })
    } else {
      this.setState({ attempts, caught: false, failed: true })
    }
  }

  render(): ReactNode {
    if (this.state.failed || this.state.caught) return null
    return (
      <React.Fragment key={this.state.remountKey}>
        {this.props.children}
      </React.Fragment>
    )
  }
}

interface AppBoundaryProps {
  children: ReactNode
}

interface AppBoundaryState {
  errored: boolean
}

/**
 * The last line of defence: a render exception anywhere below shows a message
 * the rider can act on rather than an empty white page.
 */
export class AppErrorBoundary extends Component<
  AppBoundaryProps,
  AppBoundaryState
> {
  constructor(props: AppBoundaryProps) {
    super(props)
    this.state = { errored: false }
  }

  static getDerivedStateFromError(): AppBoundaryState {
    return { errored: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportBoundaryError('app', 'app', error, info)
  }

  reload = (): void => {
    try {
      window.location.reload()
    } catch (e) {
      this.setState({ errored: false })
    }
  }

  render(): ReactNode {
    if (!this.state.errored) return <>{this.props.children}</>
    // Deliberately NOT react-intl: the IntlProvider lives inside
    // ResponsiveWebapp (lib/components/app/responsive-webapp.js:375), which is
    // below this boundary, so a <FormattedMessage> here would throw inside the
    // fallback and put the white screen right back.
    return (
      <div
        role="alert"
        style={{
          margin: '0 auto',
          maxWidth: '32em',
          padding: '2em 1.5em',
          textAlign: 'center'
        }}
      >
        <h2>Something went wrong</h2>
        <p>Reload to keep going. Your trip is not lost.</p>
        <button onClick={this.reload} type="button">
          Reload
        </button>
      </div>
    )
  }
}

export default AppErrorBoundary
