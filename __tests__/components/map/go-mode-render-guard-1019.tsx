import fs from 'fs'
import path from 'path'

import ts from 'typescript'

import {
  hasRenderGuardShape,
  installMapRenderGuard,
  RENDER_RECOVERED_MIN_INTERVAL_MS
} from '../../../lib/util/go-mode/map-render-guard'

/**
 * Backlog 59.1. Ride 2026-10-19 08:47:36: one `this._onEaseFrame is not a
 * function` thrown inside MapLibre's render task queue, then `Attempting to
 * run(), but is already running.` on every frame — 306 + 19 errors, the map
 * frozen for about 18 min, through STOP/START Go Mode.
 *
 * These tests run the REAL maplibre-gl TaskQueue (transpiled from the
 * installed package's own source), so they also pin the private shape the
 * guard relies on: a MapLibre upgrade that changes it fails here.
 */

const MAPLIBRE = path.join(
  path.dirname(require.resolve('maplibre-gl/package.json'))
)
const readSrc = (rel: string) =>
  fs.readFileSync(path.join(MAPLIBRE, 'src', rel), 'utf8')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadTaskQueue = (): any => {
  const { outputText } = ts.transpileModule(readSrc('util/task_queue.ts'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019
    }
  })
  const module = { exports: {} as Record<string, unknown> }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', outputText)(module, module.exports)
  return module.exports.TaskQueue
}
const TaskQueue = loadTaskQueue()

// What Map._render does with the queue (map.ts: run, then draw).
const makeMap = () => {
  const map = {
    _render(t = 0) {
      this._renderTaskQueue.run(t)
      this.draws += 1
    },
    _renderTaskQueue: new TaskQueue(),
    draws: 0,
    triggerRepaint: jest.fn()
  }
  return map
}

describe('map render guard (59.1)', () => {
  let now = 0
  const clock = () => now
  beforeEach(() => {
    now = 1_792_418_855_000
  })

  describe('the maplibre-gl private shape it relies on', () => {
    it('is maplibre-gl 5.6.1, or this test and the guard need re-reading', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { version } = require('maplibre-gl/package.json')
      expect(version).toBe('5.6.1')
    })

    it('TaskQueue still has the unguarded run() the guard wraps', () => {
      const src = readSrc('util/task_queue.ts')
      expect(src).toMatch(
        /if \(this\._currentlyRunning\) throw new Error\('Attempting to run\(\), but is already running\.'\);/
      )
      // No try/finally upstream yet — when one appears the guard is spare.
      expect(src).not.toMatch(/finally/)
      const q = new TaskQueue()
      expect(Array.isArray(q._queue)).toBe(true)
      expect(q._cleared).toBe(false)
      expect(q._currentlyRunning).toBe(false)
      expect(typeof q.add).toBe('function')
      expect(typeof q.run).toBe('function')
    })

    it('Map keeps its frames on _renderTaskQueue and runs it from _render', () => {
      const src = readSrc('ui/map.ts')
      expect(src).toMatch(/_renderTaskQueue = new TaskQueue\(\)/)
      expect(src).toMatch(/return this\._renderTaskQueue\.add\(callback\)/)
      expect(src).toMatch(/this\._renderTaskQueue\.run\(paintStartTimeStamp\)/)
      expect(src).toMatch(/triggerRepaint\(\)/)
    })

    it('the camera ease frame still calls _onEaseFrame unguarded (the trigger)', () => {
      const src = readSrc('ui/camera.ts')
      expect(src).toMatch(
        /_renderFrameCallback = \(\) => \{[\s\S]{0,200}this\._onEaseFrame\(this\._easeOptions\.easing\(t\)\)/
      )
      expect(src).toMatch(/delete this\._onEaseFrame;/)
    })

    it('hasRenderGuardShape accepts the real queue and rejects anything else', () => {
      expect(hasRenderGuardShape(makeMap())).toBe(true)
      expect(hasRenderGuardShape(null)).toBe(false)
      expect(hasRenderGuardShape({ triggerRepaint: () => undefined })).toBe(
        false
      )
      expect(
        hasRenderGuardShape({ _renderTaskQueue: { run: () => undefined } })
      ).toBe(false)
    })
  })

  it('without the guard, one throwing frame locks the queue for good (the bug)', () => {
    const map = makeMap()
    map._renderTaskQueue.add(() => {
      throw new TypeError('this._onEaseFrame is not a function')
    })
    expect(() => map._render()).toThrow('this._onEaseFrame is not a function')
    for (let i = 0; i < 3; i++) {
      expect(() => map._render()).toThrow(
        'Attempting to run(), but is already running.'
      )
    }
    expect(map.draws).toBe(0)
  })

  it('with the guard, an injected throwing frame is dropped and the map draws again', () => {
    const map = makeMap()
    const report = jest.fn()
    installMapRenderGuard(map, report, clock)
    const ran: string[] = []
    map._renderTaskQueue.add(() => ran.push('before'))
    map._renderTaskQueue.add(() => {
      throw new TypeError('this._onEaseFrame is not a function')
    })
    map._renderTaskQueue.add(() => ran.push('after'))

    expect(() => map._render()).not.toThrow()
    // The rest of the frame still ran, and the map drew it.
    expect(ran).toEqual(['before', 'after'])
    expect(map.draws).toBe(1)
    expect(map._renderTaskQueue._currentlyRunning).toBe(false)
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({
      message: 'this._onEaseFrame is not a function',
      suppressed: 0
    })

    // Later frames keep running and drawing.
    const later = jest.fn()
    map._renderTaskQueue.add(later)
    map._render(16)
    map._render(32)
    expect(later).toHaveBeenCalledWith(16)
    expect(map.draws).toBe(3)
  })

  it('cancelling a frame by id still works through the wrapper', () => {
    const map = makeMap()
    installMapRenderGuard(map, null, clock)
    const cb = jest.fn()
    const id = map._renderTaskQueue.add(cb)
    map._renderTaskQueue.remove(id)
    map._render()
    expect(cb).not.toHaveBeenCalled()
  })

  it('revives a queue that was already locked when the guard went on', () => {
    const map = makeMap()
    map._renderTaskQueue.add(() => {
      throw new TypeError('this._onEaseFrame is not a function')
    })
    expect(() => map._render()).toThrow()
    const report = jest.fn()
    installMapRenderGuard(map, report, clock)
    // The first run hits the stale lock, resets it; the next one draws.
    expect(() => map._render()).not.toThrow()
    map._render()
    expect(map._renderTaskQueue._currentlyRunning).toBe(false)
    expect(map.draws).toBe(2)
    expect(report).toHaveBeenCalledWith({
      message: 'Attempting to run(), but is already running.',
      suppressed: 0
    })
  })

  it('records at most once a minute, counting the ones in between', () => {
    const map = makeMap()
    const report = jest.fn()
    installMapRenderGuard(map, report, clock)
    const throwOnce = () =>
      map._renderTaskQueue.add(() => {
        throw new Error('boom')
      })
    throwOnce()
    map._render()
    for (let i = 0; i < 4; i++) {
      now += 1000
      throwOnce()
      map._render()
    }
    expect(report).toHaveBeenCalledTimes(1)
    expect(map.triggerRepaint).toHaveBeenCalledTimes(5)
    now += RENDER_RECOVERED_MIN_INTERVAL_MS
    throwOnce()
    map._render()
    expect(report).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenLastCalledWith({ message: 'boom', suppressed: 4 })
  })

  it('wraps once per map instance; a remount swaps the recorder, unmount detaches it', () => {
    const map = makeMap()
    const first = jest.fn()
    const second = jest.fn()
    const detachFirst = installMapRenderGuard(map, first, clock)
    const run = map._renderTaskQueue.run
    const add = map._renderTaskQueue.add
    detachFirst()
    const detachSecond = installMapRenderGuard(map, second, clock)
    // Not wrapped twice.
    expect(map._renderTaskQueue.run).toBe(run)
    expect(map._renderTaskQueue.add).toBe(add)
    map._renderTaskQueue.add(() => {
      throw new Error('boom')
    })
    map._render()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    // A stale detach from the first mount leaves the second recorder alone.
    detachFirst()
    now += RENDER_RECOVERED_MIN_INTERVAL_MS
    map._renderTaskQueue.add(() => {
      throw new Error('boom')
    })
    map._render()
    expect(second).toHaveBeenCalledTimes(2)
    detachSecond()
    now += RENDER_RECOVERED_MIN_INTERVAL_MS
    map._renderTaskQueue.add(() => {
      throw new Error('boom')
    })
    // Still guarded with nobody recording.
    expect(() => map._render()).not.toThrow()
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('leaves a map without the private shape alone', () => {
    const odd = { triggerRepaint: jest.fn() }
    const detach = installMapRenderGuard(odd, jest.fn(), clock)
    expect(odd).toEqual({ triggerRepaint: expect.any(Function) })
    expect(() => detach()).not.toThrow()
  })
})
