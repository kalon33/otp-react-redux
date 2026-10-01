import fs from 'fs'
import path from 'path'

const REPO = path.join(__dirname, '..', '..', '..')
const css = fs.readFileSync(
  path.join(REPO, 'lib', 'components', 'app', 'app.css'),
  'utf8'
)
const appFrame = fs.readFileSync(
  path.join(REPO, 'lib', 'components', 'app', 'app-frame.tsx'),
  'utf8'
)

/**
 * The ReturnToTripBanner (components/app/return-to-trip-banner.tsx) is
 * position: absolute at top: 50px and publishes its measured height as
 * --return-to-trip-banner-height. Every fixed mobile screen adds that height to
 * its own `top`, so the strip is vacated rather than covered — but the AppFrame
 * pages (/feedback, /settings, saved places) are routed outside the
 * mobile-screen tree and read nothing, and the DesktopNav above them is
 * position: static. On 2026-09-20 12:54:48 the rider photographed the banner
 * lying over the feedback form ("The 'tap to return' is still overlapping on
 * pages. This feedback page for example"; backlog 12.8, second sighting).
 *
 * Measured in Chrome on a dump of the mounted feedback screen with the banner
 * up: banner 50..106, `main` 92..400, `h1` 112..152 — the banner ate 14px of
 * main and cleared the heading by 6px. With the padding: `h1` 168..208, the
 * full 56px of banner below its bottom edge.
 */
describe('AppFrame vacates the return-to-trip banner strip', () => {
  it('pads its main by the published banner height', () => {
    const match = css.match(/#otp\s*>\s*main\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    expect(match[1]).toMatch(
      /padding-top:\s*var\(--return-to-trip-banner-height,\s*0px\)/
    )
  })

  it('still renders that main directly inside #otp, so the rule matches', () => {
    // The selector is the whole fix; a refactor that renames the id or buries
    // the <main> would leave the padding silently inert.
    expect(appFrame).toMatch(/id="otp"/)
    expect(appFrame).toMatch(/<main tabIndex=\{-1\}>/)
  })
})
