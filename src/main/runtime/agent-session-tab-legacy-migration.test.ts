import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { agentSessionLeaseFixture, agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore,
  storedTestAgentSessionRecord
} from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'

/**
 * Legacy stores here mean stores written before chat-tab visibility existed: records with no
 * `agent_session_tabs` index. They are the HQ-92 case, because every recorded conversation was
 * visible then and none of them may silently disappear.
 */
const legacyIds = ['hq92-legacy-a', 'hq92-legacy-b', 'hq92-legacy-c']
let root: string

const sorted = (ids: readonly string[]): string[] => [...ids].sort()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hq92-legacy-tabs-'))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function seedLegacyStore() {
  await seedTestAgentSessionRecordStore(root, {
    records: legacyIds.map((sessionId) => agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })))
  })
  return openTestAgentSessionRecordStore(root)
}

describe('legacy tab migration keeps existing chats visible (HQ-92)', () => {
  it('reads a legacy store as every recorded conversation visible, not as nothing visible', async () => {
    const store = await seedLegacyStore()
    const index = store.getVisibleSessionTabIndex()
    expect(index.present).toBe(false)
    expect(sorted(index.sessionIds)).toEqual(sorted(legacyIds))
    // A visible legacy chat also needs a tab identity before any first write;
    // retirement admission reads this value without materializing the index.
    expect(store.getSessionTabId(legacyIds[0])).toBe(structuredAgentSessionTabId(legacyIds[0]))
    expect(store.getSessionTabId('hq92-no-such-session')).toBeNull()
    expect(store.getVisibleSessionTabIndex().present).toBe(false)
  })

  it('does not let a first single-session write replace the legacy visible-tab set', async () => {
    const store = await seedLegacyStore()
    await store.setSessionTabVisibility(legacyIds[0], false)
    // The write must inherit the legacy set instead of starting a new index that holds one member.
    expect(sorted(store.listVisibleSessionIds())).toEqual(sorted(legacyIds.slice(1)))
    const persisted = await readPersistedTestAgentSessionStore(root)
    expect(persisted.sessionTabs?.length ?? 0).toBe(legacyIds.length - 1)
    expect(persisted.sessionTabs?.map((entry) => entry.sessionId).sort()).toEqual(sorted(legacyIds.slice(1)))
  })

  it('restores a hidden legacy chat under its own tab id and keeps the others untouched', async () => {
    const store = await seedLegacyStore()
    const tabId = structuredAgentSessionTabId(legacyIds[0])
    await store.setSessionTabVisibility(legacyIds[0], false)
    expect(store.getSessionTabId(legacyIds[0])).toBeNull()
    await store.setSessionTabVisibility(legacyIds[0], true, tabId)
    expect(store.getSessionTabId(legacyIds[0])).toBe(tabId)
    expect(sorted(store.listVisibleSessionIds())).toEqual(sorted(legacyIds))
  })

  it('keeps the migration and the hidden state across a restart', async () => {
    const store = await seedLegacyStore()
    await store.setSessionTabVisibility(legacyIds[1], false)
    closeTestJournalHostDatabases()
    const reopened = await openTestAgentSessionRecordStore(root)
    expect(reopened.getVisibleSessionTabIndex().present).toBe(true)
    expect(sorted(reopened.listVisibleSessionIds())).toEqual(sorted([legacyIds[0], legacyIds[2]]))
    expect(reopened.getSessionTabId(legacyIds[1])).toBeNull()
  })

  it('adds a newly created session to the visible set without dropping migrated legacy tabs', async () => {
    const store = await seedLegacyStore()
    await store.setSessionTabVisibility(legacyIds[0], false)
    const createdId = 'hq92-newly-created'
    await editPersistedTestAgentSessionStore(root, (persisted) => {
      persisted.records[createdId] = storedTestAgentSessionRecord(
        agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: createdId }))
      )
    })
    closeTestJournalHostDatabases()
    const reopened = await openTestAgentSessionRecordStore(root)
    await reopened.setSessionTabVisibility(createdId, true)
    expect(sorted(reopened.listVisibleSessionIds())).toEqual(
      sorted([legacyIds[1], legacyIds[2], createdId])
    )
    expect(reopened.getSessionTabId(legacyIds[1])).toBe(structuredAgentSessionTabId(legacyIds[1]))
  })

  it('preserves unrelated legacy tabs when hiding through the retirement receipt path', async () => {
    const store = await seedLegacyStore()
    const target = legacyIds[2]
    const tabId = structuredAgentSessionTabId(target)
    await store.commitOperationReceipt(
      store.sessionTabVisibilityReceipt(target, tabId, () => undefined)
    )
    expect(store.getSessionTabId(target)).toBeNull()
    expect(sorted(store.listVisibleSessionIds())).toEqual(sorted(legacyIds.slice(0, 2)))
    expect(store.getRecord(legacyIds[0])?.sessionId).toBe(legacyIds[0])
    expect(store.getRecord(legacyIds[1])?.sessionId).toBe(legacyIds[1])
  })
})
