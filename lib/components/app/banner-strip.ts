import { useEffect, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * The strip under the 50px app bar, and the banners that share it.
 *
 * Two banners live there, both `position: absolute` under the bar: the
 * network-lost strip (network-connection-banner.tsx) and the return-to-trip
 * banner (return-to-trip-banner.tsx), stacked in that order. Neither may cover
 * what is below it, so each publishes its measured height here and the screens
 * below start under the SUM, read as --return-to-trip-banner-height: every
 * fixed mobile screen adds it to its `top` (mobile.css and the screens'
 * styled-components), AppFrame's main pads by it (app.css `#otp > main`) and
 * the diagnostics notice offsets by it. The name predates the second banner
 * (12.8); its readers want "how much of the strip is taken", so none of them
 * had to change. --network-banner-height is the network strip alone: the
 * return-to-trip banner stacks under it, and Go Mode — whose own 44px bar
 * never carries the return banner — moves its card down by it.
 *
 * 75.16 (chaos C12, 2026-10-29): the network strip published nothing, so while
 * the phone was offline it lay over the results summary card's from → to line
 * and Edit button, and in Go Mode over the card's ← / route pill / headsign.
 */
export const BANNER_HEIGHT_VAR = '--return-to-trip-banner-height'
export const NETWORK_BANNER_HEIGHT_VAR = '--network-banner-height'

export type StripBanner = 'network' | 'returnToTrip'

const heights: Record<StripBanner, number> = { network: 0, returnToTrip: 0 }

/** Record one banner's height and republish both variables on <html>. */
export function publishBannerHeight(banner: StripBanner, px: number): void {
  heights[banner] = px
  const root = document.documentElement
  root.style.setProperty(NETWORK_BANNER_HEIGHT_VAR, `${heights.network}px`)
  root.style.setProperty(
    BANNER_HEIGHT_VAR,
    `${heights.network + heights.returnToTrip}px`
  )
}

/**
 * Measure a strip banner while it is visible and publish its height; 0 when it
 * is not, and on unmount. Measured rather than assumed: the copy wraps to two
 * lines on a narrow phone (the return banner did in the 2026-09-08
 * screenshot), and a hard-coded strip would be wrong on one of the two.
 * `remeasure` is anything whose change can re-flow the copy (the message).
 */
export function usePublishedBannerHeight(
  banner: StripBanner,
  ref: RefObject<HTMLElement>,
  visible: boolean,
  remeasure?: unknown
): void {
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!visible || !el) {
      setHeight(0)
      return
    }
    const measure = () => setHeight(el.getBoundingClientRect().height)
    measure()
    const Observer = (
      window as unknown as { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver
    if (!Observer) return
    const observer = new Observer(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // The ref is read when the effect runs; it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, remeasure])

  useEffect(() => {
    publishBannerHeight(banner, height)
    return () => publishBannerHeight(banner, 0)
  }, [banner, height])
}
