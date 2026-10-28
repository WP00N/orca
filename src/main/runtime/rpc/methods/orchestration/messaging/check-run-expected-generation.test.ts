import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const OTHER_PANE = 'tab_other:33333333-3333-4333-8333-333333333333'

describe('HQ-89 expected consumer generation fences Run check and ACK', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>

  beforeEach(() => {
    state = h.setup()
  })

  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })

  function runId(): string {
    if (!state.activeRunId) {
      throw new Error('Run missing')
    }
    return state.activeRunId
  }

  function generation(): number {
    const run = state.db.getRun(runId())
    if (!run) {
      throw new Error('Run missing')
    }
    return run.consumer_generation
  }

  function check(extra: Record<string, unknown>) {
    const method =
      extra.expectedConsumerGeneration === undefined
        ? 'orchestration.check'
        : 'orchestration.checkFenced'
    return h.call(
      method,
      {
        terminal: 'term_coord',
        run: runId(),
        ...extra
      },
      state.ctx
    )
  }

  function message() {
    return state.db.insertMessage({
      from: 'worker',
      to: `run:${runId()}`,
      runId: runId(),
      subject: 'ready'
    })
  }

  function rebindAwayAndBack() {
    const old = generation()
    state.db.bindRun({
      runId: runId(),
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: OTHER_PANE
    })
    const rebound = state.db.bindRun({
      runId: runId(),
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey
    })
    expect(rebound?.consumer_generation).toBeGreaterThan(old)
  }

  it('returns server consumer generation with the whole FIFO Delivery', async () => {
    const msg = message()
    const current = generation()
    const result = await check({ expectedConsumerGeneration: current })
    expect(result).toMatchObject({
      runId: runId(),
      consumerGeneration: current,
      count: 1,
      messages: [{ id: msg.id }],
      deliveryId: expect.any(String)
    })
    expect(await check({ expectedConsumerGeneration: current })).toMatchObject({
      deliveryId: expect.any(String),
      consumerGeneration: current,
      replayed: true
    })
  })

  it('returns the verified generation even when no batch exists', async () => {
    const current = generation()
    expect(await check({ expectedConsumerGeneration: current })).toMatchObject({
      runId: runId(),
      count: 0,
      deliveryId: null,
      consumerGeneration: current
    })
    expect(state.db.hasOutstandingRunDelivery(runId())).toBe(false)
  })

  it('ACK plus peek does not open another unprocessed FIFO batch', async () => {
    const current = generation()
    const first = message()
    const initial = await check({ expectedConsumerGeneration: current })
    if (
      !initial ||
      typeof initial !== 'object' ||
      !('deliveryId' in initial) ||
      typeof initial.deliveryId !== 'string'
    ) {
      throw new Error('Missing source Delivery')
    }
    const second = message()
    const result = await check({
      expectedConsumerGeneration: current,
      ack: initial.deliveryId,
      peek: true
    })
    expect(result).toMatchObject({
      runId: runId(),
      consumerGeneration: current,
      acknowledged: initial.deliveryId,
      count: 1,
      messages: [{ id: second.id }]
    })
    expect(state.db.hasOutstandingRunDelivery(runId())).toBe(false)
    expect(state.db.getMessageById(first.id)?.read).toBe(1)
    expect(state.db.getMessageById(second.id)?.read).toBe(0)
  })

  it('rejects stale caller after ABA rebind before routing or acquiring mail', async () => {
    const stale = generation()
    const msg = message()
    rebindAwayAndBack()
    const route = vi.spyOn(state.db, 'routeUnreadDirectMessagesToRunMailbox')
    const changesBefore = state.db.db.prepare('SELECT total_changes() AS n').get()
    await expect(check({ expectedConsumerGeneration: stale })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(route).not.toHaveBeenCalled()
    expect(state.db.hasOutstandingRunDelivery(runId())).toBe(false)
    expect(state.db.getMessageById(msg.id)?.read).toBe(0)
    expect(state.db.db.prepare('SELECT total_changes() AS n').get()).toEqual(changesBefore)
  })

  it('refuses stale expected generation before acknowledging a current Delivery', async () => {
    const stale = generation()
    rebindAwayAndBack()
    const msg = message()
    const current = generation()
    const acquired = await check({ expectedConsumerGeneration: current })
    if (!acquired || typeof acquired !== 'object' || !('deliveryId' in acquired)) {
      throw new Error('Missing Delivery')
    }
    const delivery = acquired.deliveryId
    if (typeof delivery !== 'string') {
      throw new Error('Missing Delivery ID')
    }
    await expect(check({ expectedConsumerGeneration: stale, ack: delivery })).rejects.toMatchObject(
      {
        code: 'consumer_fenced'
      }
    )
    expect(state.db.getDeliveryRaw(delivery)?.acknowledged_at).toBeNull()
    expect(state.db.getMessageById(msg.id)?.read).toBe(0)
  })

  it('retains the old optional-parameter contract, but forbids ambiguous expected Run', async () => {
    message()
    expect(await check({})).toMatchObject({ count: 1, deliveryId: expect.any(String) })
    await expect(
      h.call(
        'orchestration.checkFenced',
        {
          terminal: 'term_coord',
          expectedConsumerGeneration: generation()
        },
        state.ctx
      )
    ).rejects.toThrow()
  })

  it.each([false, '1', -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-positive, unsafe or non-integer expected generation %s',
    async (value) => {
      await expect(check({ expectedConsumerGeneration: value })).rejects.toThrow()
    }
  )

  it('preserves a fenced ACK receipt when the following wait is interrupted', async () => {
    const current = generation()
    message()
    const first = await check({ expectedConsumerGeneration: current })
    if (
      !first ||
      typeof first !== 'object' ||
      !('deliveryId' in first) ||
      typeof first.deliveryId !== 'string'
    ) {
      throw new Error('Missing source Delivery')
    }
    vi.spyOn(state.runtime, 'waitForMessage').mockResolvedValueOnce('waiter_exists')
    const result = await check({
      expectedConsumerGeneration: current,
      ack: first.deliveryId,
      wait: true
    })
    expect(result).toMatchObject({
      runId: runId(),
      consumerGeneration: current,
      acknowledged: first.deliveryId,
      waitInterrupted: 'waiter_exists'
    })
    expect(state.db.getDeliveryRaw(first.deliveryId)?.acknowledged_at).not.toBeNull()
  })

  it('fences every routed page when ownership ABA changes between pages', async () => {
    const stale = generation()
    for (let index = 0; index < 101; index += 1) {
      const direct = state.db.insertMessage({
        from: 'worker',
        to: 'term_coord',
        runId: runId(),
        subject: `Pending page ${index}`
      })
      // Run-aware insertion routes immediately; explicitly recreate the
      // pre-routing direct-mail snapshot exercised by this race test.
      state.db.db
        .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
        .run('term_coord', direct.id)
    }
    const original = state.db.routeUnreadDirectMessagesToRunMailbox.bind(state.db)
    let count = 0
    let changesAfterRebind = -1
    vi.spyOn(state.db, 'routeUnreadDirectMessagesToRunMailbox').mockImplementation((...args) => {
      count += 1
      if (count === 2) {
        expect(args[3]).toBe(stale)
        rebindAwayAndBack()
        changesAfterRebind = (
          state.db.db.prepare('SELECT total_changes() AS n').get() as { n: number }
        ).n
      }
      return original(...args)
    })
    await expect(check({ expectedConsumerGeneration: stale })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(count).toBe(2)
    // Rebinding itself may reroute direct mail. What must not happen is
    // ANY further routing mutation by this stale check after rebinding.
    expect(changesAfterRebind).toBeGreaterThan(0)
    expect((state.db.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(
      changesAfterRebind
    )
    expect(state.db.hasOutstandingRunDelivery(runId())).toBe(false)
  })

  it('also fences when a rebind interleaves after the request starts', async () => {
    const old = generation()
    const msg = message()
    const original = state.db.getOrCreateRunDelivery.bind(state.db)
    const acquisition = vi.spyOn(state.db, 'getOrCreateRunDelivery')
    acquisition.mockImplementationOnce((params) => {
      rebindAwayAndBack()
      return original(params)
    })
    await expect(check({ expectedConsumerGeneration: old })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(state.db.hasOutstandingRunDelivery(runId())).toBe(false)
    expect(state.db.getMessageById(msg.id)?.read).toBe(0)
  })
})
