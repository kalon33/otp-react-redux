import '../../test-utils/mock-window-url'
import { BANNER_HEIGHT_VAR } from '../../../lib/components/app/return-to-trip-banner'
import { mockWithProvider } from '../../test-utils/mock-data/store'
import DiagnosticsNotice from '../../../lib/components/app/diagnostics-notice'

jest.mock('../../../lib/util/debug-log', () => ({
  acknowledgeDiagnosticsNotice: jest.fn(),
  shouldShowDiagnosticsNotice: () => true
}))

/**
 * Backlog 26.5, the rider's 2026-09-22 08:22:06 screenshot ("Overlap"): the
 * diagnostics notice sat on the green "On trip · Next stop …" banner. Both
 * claim the strip under the 50 px nav — the banner absolutely, the notice in
 * flow — and the notice's z-index 27 beat the banner's 26. The notice now
 * moves down by the height the banner publishes.
 */
describe('components > app > DiagnosticsNotice (backlog 26.5)', () => {
  it('offsets itself by the published return-to-trip banner height', () => {
    mockWithProvider(DiagnosticsNotice, {})
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent)
      .join('\n')
    expect(BANNER_HEIGHT_VAR).toBe('--return-to-trip-banner-height')
    expect(css).toMatch(
      /position:\s*relative;\s*top:\s*var\(--return-to-trip-banner-height,\s*0px\)/
    )
  })
})
