import {
  beginForegroundSearch,
  MAX_CONCURRENT_PLAN_QUERIES,
  planQueryLoad,
  resetPlanQueryGate,
  runPlanQuery
} from '../../lib/util/plan-concurrency'

/** A task whose promise this test resolves by hand. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (err: unknown) => void = () => undefined
  // eslint-disable-next-line promise/param-names
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('util > plan-concurrency > runPlanQuery', () => {
  beforeEach(resetPlanQueryGate)

  /**
   * Backlog 17.8, measured on the Linode against the JVM the 2026-09-15 ride
   * ran on: x5 concurrent cap-10000 plans took 120.11 s wall and 4 of the 5
   * came back `OutOfMemoryError`, while the same five serial at the server's
   * own cap were 2 s each. The ride sent six at once.
   */
  it('runs only two at a time and starts the third when one settles', async () => {
    const started: number[] = []
    const gates = [deferred(), deferred(), deferred()]
    const results = gates.map((gate, i) =>
      runPlanQuery(() => {
        started.push(i)
        return gate.promise
      })
    )

    await flush()
    expect(started).toEqual([0, 1])
    expect(planQueryLoad()).toMatchObject({ queued: 1, running: 2 })

    gates[0].resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])
    expect(planQueryLoad()).toMatchObject({ queued: 0, running: 2 })

    gates[1].resolve()
    gates[2].resolve()
    await Promise.all(results)
    expect(planQueryLoad()).toMatchObject({ queued: 0, running: 0 })
  })

  it('is FIFO, so the combination that waits is the last one built', async () => {
    const started: string[] = []
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const all = ['a', 'b', 'c', 'd'].map((name, i) =>
      runPlanQuery(() => {
        started.push(name)
        return gates[i].promise
      })
    )
    await flush()
    expect(started).toEqual(['a', 'b'])
    gates[0].resolve()
    gates[1].resolve()
    await flush()
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    gates[2].resolve()
    gates[3].resolve()
    await Promise.all(all)
  })

  it('releases the slot when a plan fails, so a sick server cannot wedge the planner', async () => {
    const failing = runPlanQuery(() => Promise.reject(new Error('OOM')))
    await expect(failing).rejects.toThrow('OOM')
    expect(planQueryLoad()).toMatchObject({ running: 0 })

    const throwing = runPlanQuery(() => {
      throw new Error('bad variables')
    })
    await expect(throwing).rejects.toThrow('bad variables')
    expect(planQueryLoad()).toMatchObject({ running: 0 })
  })

  it('passes the task’s value through', async () => {
    await expect(runPlanQuery(() => 'plan')).resolves.toBe('plan')
  })

  it('takes a lower bound from config and keeps it', async () => {
    const started: number[] = []
    const gates = [deferred(), deferred()]
    gates.forEach((gate, i) =>
      runPlanQuery(() => {
        started.push(i)
        return gate.promise
      }, 1)
    )
    await flush()
    expect(started).toEqual([0])
    expect(planQueryLoad()).toMatchObject({ limit: 1, queued: 1 })
    gates[0].resolve()
    gates[1].resolve()
    await flush()
    expect(started).toEqual([0, 1])
  })

  it('ignores a nonsense bound rather than blocking every plan', async () => {
    await runPlanQuery(() => undefined, 0)
    expect(planQueryLoad().limit).toBe(MAX_CONCURRENT_PLAN_QUERIES)
    await runPlanQuery(() => undefined, null)
    expect(planQueryLoad().limit).toBe(MAX_CONCURRENT_PLAN_QUERIES)
  })

  it('reclaims a slot whose task never settles, so the planner cannot deadlock', async () => {
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    const started: number[] = []
    const wedged = deferred()
    runPlanQuery(() => {
      started.push(0)
      return wedged.promise
    })
    runPlanQuery(() => {
      started.push(1)
      return wedged.promise
    })
    await flush()
    expect(started).toEqual([0, 1])

    // A third plan 31 s later: both slots are past PLAN_SLOT_MAX_MS.
    now.mockReturnValue(1_031_000)
    runPlanQuery(() => {
      started.push(2)
      return deferred().promise
    })
    await flush()
    expect(started).toEqual([0, 1, 2])
    now.mockRestore()
    wedged.resolve()
  })
})

describe('util > plan-concurrency > beginForegroundSearch', () => {
  beforeEach(resetPlanQueryGate)

  /**
   * The ride's own telemetry: two ROUTING_REQUESTs with distinct search ids
   * 0.4-0.9 s apart, three times over (20:48:50.451 + 20:48:51.837,
   * 20:49:19.352 + 20:49:20.066, 20:49:47.993 + 20:49:48.852), each
   * `pending: 3`. The second is the same question.
   */
  it('refuses the identical question while the first is in flight', () => {
    const release = beginForegroundSearch('sig')
    expect(release).toBeInstanceOf(Function)
    expect(beginForegroundSearch('sig')).toBeNull()
  })

  it('lets a different search through', () => {
    beginForegroundSearch('sig')
    expect(beginForegroundSearch('other')).toBeInstanceOf(Function)
  })

  it('lets the rider ask again once the first search has settled', () => {
    const release = beginForegroundSearch('sig')
    release?.()
    expect(beginForegroundSearch('sig')).toBeInstanceOf(Function)
  })

  it('never lets a lost release lock the planner for the session', () => {
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(2_000_000)
    beginForegroundSearch('sig')
    now.mockReturnValue(2_000_000 + 44_000)
    expect(beginForegroundSearch('sig')).toBeNull()
    now.mockReturnValue(2_000_000 + 46_000)
    expect(beginForegroundSearch('sig')).toBeInstanceOf(Function)
    expect(planQueryLoad().latches).toBe(1)
    now.mockRestore()
  })

  it('a stale release does not drop the latch of the search that replaced it', () => {
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(3_000_000)
    const stale = beginForegroundSearch('sig')
    now.mockReturnValue(3_000_000 + 46_000)
    beginForegroundSearch('sig')
    stale?.()
    expect(planQueryLoad().latches).toBe(1)
    expect(beginForegroundSearch('sig')).toBeNull()
    now.mockRestore()
  })
})
