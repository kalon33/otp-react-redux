import fs from 'fs'
import path from 'path'

const CSS_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'lib',
  'components',
  'app',
  'app.css'
)

const css = fs.readFileSync(CSS_PATH, 'utf8')

/** Body of the first rule whose selector matches exactly. */
function ruleBody(selector) {
  const match = css.match(
    new RegExp(
      `(^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`,
      'm'
    )
  )
  if (!match) throw new Error(`No CSS rule for ${selector} in app.css`)
  return match[2]
}

/**
 * The "Skip navigation" button (components/app/app-menu.tsx) is position:fixed
 * and parked off the top of the viewport until focused. It used to be parked
 * with `top: -30px` — a guess at the height of the UA button box, which is
 * 29px in desktop WebKit/Blink but taller in WKWebView on iOS. On the phone the
 * bottom ~2.7 CSS px of the button's light #e9e9ea face therefore painted as a
 * rounded strip above the navbar (backlog 9.4, "white line along the top
 * border": Go Mode 2026-09-04, feedback screen 2026-09-06).
 *
 * So: the resting offset must not be a pixel length, because any pixel length
 * is an assumption about how tall the user agent renders the button.
 */
describe('skip-nav-button', () => {
  it('is parked off-screen by an offset that does not assume its height', () => {
    const body = ruleBody('.skip-nav-button')
    expect(body).toMatch(/position:\s*fixed/)

    const top = body.match(/(^|;)\s*top:\s*([^;]+);/)
    expect(top).not.toBeNull()
    const value = top[2].trim()

    // A negative px offset only hides the button if it is shorter than that
    // offset — which is exactly the assumption that failed on iOS.
    expect(value).not.toMatch(/px$/)
    // Still has to be off the top of the viewport.
    expect(value).toMatch(/^-/)
  })

  it('comes back on screen when focused', () => {
    const body = ruleBody('.skip-nav-button:focus')
    expect(body).toMatch(/top:\s*7px/)
  })
})
