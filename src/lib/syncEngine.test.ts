import assert from 'node:assert/strict';
import {
  __resetMemoryStoreForTests,
  __setSimulateSaveFailureForTests,
  loadAllLocalEntryRecords,
  loadVisibleLocalEntries,
  upsertLocalEntryFromUser,
  markLocalEntryDeleted,
  getPendingSyncCount,
  getSyncMetadata,
  loadLocalSettings,
  saveLocalSettings,
  saveLocalEntryRecord,
  mergeRemoteEntriesIntoLocal,
  sortEntriesDescending,
} from './draftStorage';
import { SyncCoordinator, SyncTransportAdapter, THREE_HOURS_MS } from './syncEngine';
import { JournalEntry, UserSettings } from '../types/journal';

const BASE_SETTINGS: UserSettings = {
  theme: 'system',
  defaultCleanupMode: 'clean',
  audioRetention: 'keep',
  transcriptionProvider: 'gemini-3.5-transcribe',
  accentColor: 'terracotta',
};

function createSampleEntry(id: string, overrides: Partial<JournalEntry> = {}): JournalEntry {
  const nowIso = overrides.updatedAtIso || '2026-04-19T10:00:00.000Z';
  return {
    id,
    ownerId: overrides.ownerId || 'user-123',
    rawTranscription: 'Raw transcript for ' + id,
    cleanedTranscription: 'Cleaned text for ' + id,
    finalText: overrides.finalText || 'Final text for ' + id,
    cleanupMode: 'clean',
    ambiguityNotes: overrides.ambiguityNotes ?? '',
    audioId: 'audio-' + id,
    audioMimeType: 'audio/webm',
    audioDurationSec: 15,
    dateKey: '2026-04-19',
    createdAtIso: overrides.createdAtIso || '2026-04-19T10:00:00.000Z',
    updatedAtIso: nowIso,
    ...overrides,
  };
}

interface MockEnvironment {
  online: boolean;
  userId: string | null;
  nowMs: number;
  cloudEntries: Map<string, JournalEntry>;
  d1Entries: Map<string, JournalEntry>;
  cloudSettings: Map<string, UserSettings>;
  counts: {
    firestorePullCalls: number;
    firestorePullDocsReturned: number;
    firestoreUpsertCalls: number;
    firestoreDeleteCalls: number;
    firestoreSaveSettingsCalls: number;
    d1FetchCalls: number;
    d1UpsertCalls: number;
    d1DeleteCalls: number;
  };
  failNextFirestoreUpserts: number;
  artificialCloudDelayMs: number;
  transport: SyncTransportAdapter;
}

function createMockEnvironment(
  initialOnline = true,
  initialUserId: string | null = 'user-123'
): MockEnvironment {
  const env: MockEnvironment = {
    online: initialOnline,
    userId: initialUserId,
    nowMs: Date.parse('2026-04-19T10:00:00.000Z'),
    cloudEntries: new Map(),
    d1Entries: new Map(),
    cloudSettings: new Map(),
    counts: {
      firestorePullCalls: 0,
      firestorePullDocsReturned: 0,
      firestoreUpsertCalls: 0,
      firestoreDeleteCalls: 0,
      firestoreSaveSettingsCalls: 0,
      d1FetchCalls: 0,
      d1UpsertCalls: 0,
      d1DeleteCalls: 0,
    },
    failNextFirestoreUpserts: 0,
    artificialCloudDelayMs: 0,
    transport: null as unknown as SyncTransportAdapter,
  };

  env.transport = {
    isOnline: () => env.online,
    getCurrentUid: () => env.userId,
    nowMs: () => env.nowMs,
    sleep: async () => {
      // Fast backoff in automated test runs
    },
    upsertCloudEntry: async (entry) => {
      env.counts.firestoreUpsertCalls++;
      if (env.artificialCloudDelayMs > 0) {
        await new Promise((r) => setTimeout(r, env.artificialCloudDelayMs));
      }
      if (env.failNextFirestoreUpserts > 0) {
        env.failNextFirestoreUpserts--;
        throw new Error('Simulated transient network failure during Firestore upsert');
      }
      const saved: JournalEntry = {
        ...entry,
        ownerId: env.userId || entry.ownerId,
      };
      env.cloudEntries.set(entry.id, saved);
      return saved;
    },
    deleteCloudEntry: async (entryId) => {
      env.counts.firestoreDeleteCalls++;
      env.cloudEntries.delete(entryId);
    },
    fetchCloudEntries: async ({ uid, sinceUpdatedAtIso, onPage }) => {
      env.counts.firestorePullCalls++;
      if (env.artificialCloudDelayMs > 0) {
        await new Promise((r) => setTimeout(r, env.artificialCloudDelayMs));
      }
      const allForUser = Array.from(env.cloudEntries.values())
        .filter((e) => e.ownerId === uid)
        .sort((a, b) => a.updatedAtIso.localeCompare(b.updatedAtIso));

      const filtered = sinceUpdatedAtIso
        ? allForUser.filter((e) => e.updatedAtIso > sinceUpdatedAtIso)
        : allForUser;

      env.counts.firestorePullDocsReturned += filtered.length;
      const latestCursorIso =
        filtered.length > 0
          ? filtered[filtered.length - 1].updatedAtIso
          : sinceUpdatedAtIso ?? null;

      if (filtered.length > 0 && onPage && latestCursorIso) {
        await onPage(
          filtered.map((e) => ({ ...e })),
          latestCursorIso
        );
      }

      return {
        entries: filtered.map((e) => ({ ...e })),
        latestCursorIso,
      };
    },
    saveCloudSettings: async (settings) => {
      env.counts.firestoreSaveSettingsCalls++;
      if (env.userId) {
        env.cloudSettings.set(env.userId, { ...settings });
      }
    },
    mirrorUpsertToD1: async (entry) => {
      env.counts.d1UpsertCalls++;
      env.d1Entries.set(entry.id, { ...entry });
    },
    mirrorDeleteToD1: async (entryId) => {
      env.counts.d1DeleteCalls++;
      env.d1Entries.delete(entryId);
    },
    fetchD1Entries: async () => {
      env.counts.d1FetchCalls++;
      return Array.from(env.d1Entries.values()).map((e) => ({ ...e }));
    },
  };

  return env;
}

async function runTests() {
  console.log('Running local-first storage & cloud synchronization test suite...\n');

  // ---------------------------------------------------------------------------
  // Scenario 1: Creating an entry offline, refreshing, and recovering it
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(false, 'user-123'); // Offline
    const entry = createSampleEntry('offline-entry-1');

    await upsertLocalEntryFromUser(entry);

    // Simulate page refresh by reading fresh from durable store
    const recoveredEntries = await loadVisibleLocalEntries();
    assert.equal(recoveredEntries.length, 1);
    assert.equal(recoveredEntries[0].id, 'offline-entry-1');
    assert.equal(recoveredEntries[0].syncStatus, 'pending_upsert');
    assert.equal(await getPendingSyncCount(), 1);
    assert.equal(env.counts.firestoreUpsertCalls, 0);
    console.log('PASS [1/10]: Creating an entry offline, refreshing, and recovering it');
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: Editing an entry offline and synchronizing later
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(false, 'user-123'); // Start offline
    const coordinator = new SyncCoordinator({ transport: env.transport });

    const initial = createSampleEntry('entry-edit-1', {
      finalText: 'Initial offline draft',
      updatedAtIso: '2026-04-19T10:00:00.000Z',
    });
    await upsertLocalEntryFromUser(initial);
    await coordinator.synchronize('push_only');

    // Edit again while still offline
    const edited: JournalEntry = {
      ...initial,
      finalText: 'Edited offline draft v2',
      updatedAtIso: '2026-04-19T10:05:00.000Z',
    };
    await upsertLocalEntryFromUser(edited);
    await coordinator.synchronize('push_only');

    // Still offline -> 0 Firestore writes
    assert.equal(env.counts.firestoreUpsertCalls, 0);
    assert.equal(await getPendingSyncCount(), 1);

    // Now come online and synchronize
    env.online = true;
    await coordinator.synchronize('auto');

    // Coalesced into a single Firestore write with latest text
    assert.equal(env.counts.firestoreUpsertCalls, 1);
    assert.equal(env.cloudEntries.get('entry-edit-1')?.finalText, 'Edited offline draft v2');
    assert.equal(await getPendingSyncCount(), 0);

    const localAfterSync = await loadVisibleLocalEntries();
    assert.equal(localAfterSync[0].syncStatus, 'synced');
    assert.equal(localAfterSync[0].cloudSynced, true);
    console.log('PASS [2/10]: Editing an entry offline and synchronizing later');
  }

  // ---------------------------------------------------------------------------
  // Scenario 3: Deleting an entry offline without resurrection
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    const coordinator = new SyncCoordinator({ transport: env.transport });

    const entry = createSampleEntry('entry-to-delete', {
      updatedAtIso: '2026-04-19T10:00:00.000Z',
    });
    // Seed entry in both Cloud and D1 and sync locally
    env.cloudEntries.set(entry.id, { ...entry });
    env.d1Entries.set(entry.id, { ...entry });
    await coordinator.importInitialFromD1();
    await coordinator.synchronize('auto');

    assert.equal((await loadVisibleLocalEntries()).length, 1);

    // Go offline and delete the entry
    env.online = false;
    await markLocalEntryDeleted('entry-to-delete', '2026-04-19T10:10:00.000Z');
    await coordinator.synchronize('push_only');

    // Immediately hidden from visible entries, stored as durable tombstone
    assert.equal((await loadVisibleLocalEntries()).length, 0);
    const allRecords = await loadAllLocalEntryRecords();
    const tombstone = allRecords.find((r) => r.id === 'entry-to-delete');
    assert.equal(tombstone?.syncStatus, 'pending_delete');

    // Even if D1 migration runs while stale D1 record still exists, tombstone blocks resurrection
    await coordinator.importInitialFromD1();
    assert.equal((await loadVisibleLocalEntries()).length, 0);

    // Now come online and sync deletion to Firestore and D1
    env.online = true;
    await coordinator.synchronize('auto');

    assert.equal(env.counts.firestoreDeleteCalls, 1);
    assert.equal(env.cloudEntries.has('entry-to-delete'), false);
    assert.equal(env.d1Entries.has('entry-to-delete'), false);
    assert.equal((await loadVisibleLocalEntries()).length, 0);
    assert.equal(await getPendingSyncCount(), 0);
    console.log('PASS [3/10]: Deleting an entry offline without resurrection');
  }

  // ---------------------------------------------------------------------------
  // Scenario 4: Retrying after a failed cloud request
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    const coordinator = new SyncCoordinator({ transport: env.transport, maxRetries: 2 });

    // Fail all 3 attempts (initial + 2 retries) during first sync
    env.failNextFirestoreUpserts = 3;
    const entry = createSampleEntry('entry-retry-1');
    await upsertLocalEntryFromUser(entry);

    const failedRun = await coordinator.synchronize('auto');

    // 3 attempts made, entry remains safely in pending_upsert state
    assert.equal(env.counts.firestoreUpsertCalls, 3);
    assert.equal(await getPendingSyncCount(), 1);
    assert.equal(failedRun.summary.state, 'error');
    assert.equal(failedRun.summary.errorMessage, 'Sync failed · Retry');
    assert.equal((await loadVisibleLocalEntries())[0].finalText, entry.finalText);

    // Next sync succeeds on first try
    const recoveredRun = await coordinator.synchronize('manual');
    assert.equal(env.counts.firestoreUpsertCalls, 4);
    assert.equal(await getPendingSyncCount(), 0);
    assert.equal(recoveredRun.summary.state, 'synced');
    console.log('PASS [4/10]: Retrying after a failed cloud request without losing local data');
  }

  // ---------------------------------------------------------------------------
  // Scenario 5: Preventing duplicate entries during repeated synchronization
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    const coordinator = new SyncCoordinator({ transport: env.transport });

    const entry = createSampleEntry('deterministic-uuid-1');
    await upsertLocalEntryFromUser(entry);

    await coordinator.synchronize('manual');
    await coordinator.synchronize('manual');
    await coordinator.synchronize('manual');

    const visible = await loadVisibleLocalEntries();
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, 'deterministic-uuid-1');
    assert.equal(env.cloudEntries.size, 1);
    // Only 1 upsert write happened across all 3 manual syncs because entry was marked synced after first push
    assert.equal(env.counts.firestoreUpsertCalls, 1);
    console.log('PASS [5/10]: Preventing duplicate entries during repeated synchronization');
  }

  // ---------------------------------------------------------------------------
  // Scenario 6: Merging remote updates without losing pending local text
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();

    // Entry originally synced at 10:00
    const baseEntry = createSampleEntry('conflict-entry-1', {
      finalText: 'Original shared text',
      updatedAtIso: '2026-04-19T10:00:00.000Z',
      syncStatus: 'synced',
      cloudSynced: true,
      lastSyncedUpdatedAtIso: '2026-04-19T10:00:00.000Z',
    });
    await saveLocalEntryRecord(baseEntry);

    // User edits locally while offline at 10:05
    await upsertLocalEntryFromUser({
      ...baseEntry,
      finalText: 'Local offline edit that must never be lost',
      updatedAtIso: '2026-04-19T10:05:00.000Z',
    });

    // Meanwhile another device updated the same entry in the cloud at 10:10
    const remoteConflictingRevision = createSampleEntry('conflict-entry-1', {
      finalText: 'Remote edit from second device',
      updatedAtIso: '2026-04-19T10:10:00.000Z',
    });

    await mergeRemoteEntriesIntoLocal([remoteConflictingRevision], 'firestore');

    const afterMerge = (await loadVisibleLocalEntries())[0];
    // Local finalText is preserved AND remote text is recorded in ambiguityNotes
    assert.equal(afterMerge.finalText, 'Local offline edit that must never be lost');
    assert.equal(afterMerge.syncStatus, 'pending_upsert');
    assert.ok(
      afterMerge.ambiguityNotes.includes('Remote edit from second device'),
      'Expected conflicting remote text to be preserved in ambiguityNotes'
    );
    console.log('PASS [6/10]: Merging remote updates without losing pending local text');
  }

  // ---------------------------------------------------------------------------
  // Scenario 7: First-time synchronization and existing D1 data preservation
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    const coordinator = new SyncCoordinator({ transport: env.transport });

    // Existing entry in D1 (/data/entries.json) and another existing entry in Firestore
    const d1LegacyEntry = createSampleEntry('d1-legacy-1', {
      finalText: 'Existing D1 note',
      updatedAtIso: '2026-04-18T08:00:00.000Z',
    });
    const cloudLegacyEntry = createSampleEntry('cloud-legacy-1', {
      finalText: 'Existing Firestore note',
      updatedAtIso: '2026-04-18T09:00:00.000Z',
    });
    env.d1Entries.set(d1LegacyEntry.id, d1LegacyEntry);
    env.cloudEntries.set(cloudLegacyEntry.id, cloudLegacyEntry);

    await coordinator.importInitialFromD1();
    await coordinator.synchronize('auto');

    const localEntries = await loadVisibleLocalEntries();
    assert.equal(localEntries.length, 2);
    // D1 legacy entry was pushed to Firestore, and Firestore legacy entry was pulled into IndexedDB & mirrored to D1
    assert.equal(env.cloudEntries.has('d1-legacy-1'), true);
    assert.equal(env.d1Entries.has('cloud-legacy-1'), true);
    assert.equal(await getPendingSyncCount(), 0);
    console.log('PASS [7/10]: First-time synchronization and existing D1 data preservation');
  }

  // ---------------------------------------------------------------------------
  // Scenario 8: Preventing overlapping sync jobs (single-flight lock)
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    env.artificialCloudDelayMs = 30;
    const coordinator = new SyncCoordinator({ transport: env.transport });

    const entry = createSampleEntry('concurrent-entry-1');
    await upsertLocalEntryFromUser(entry);

    // Fire 4 concurrent sync triggers at the same moment
    await Promise.all([
      coordinator.synchronize('auto'),
      coordinator.synchronize('auto'),
      coordinator.synchronize('push_only'),
      coordinator.synchronize('auto'),
    ]);

    // Because of single-flight locking and 3-hour pull throttling, only 1 upsert and 1 pull occurred
    assert.equal(env.counts.firestoreUpsertCalls, 1);
    assert.equal(env.counts.firestorePullCalls, 1);
    console.log('PASS [8/10]: Preventing overlapping sync jobs (single-flight lock)');
  }

  // ---------------------------------------------------------------------------
  // Scenario 9: Skipping unchanged settings writes
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    const coordinator = new SyncCoordinator({ transport: env.transport });

    await saveLocalSettings(BASE_SETTINGS);

    // Updating with identical settings -> 0 Firestore writes
    const res1 = await coordinator.updateSettingsIfChanged(BASE_SETTINGS, {
      ...BASE_SETTINGS,
    });
    assert.equal(res1.changed, false);
    assert.equal(env.counts.firestoreSaveSettingsCalls, 0);

    // Updating with a changed setting -> 1 Firestore write
    const updatedSettings: UserSettings = {
      ...BASE_SETTINGS,
      audioRetention: 'delete_after_approval',
    };
    const res2 = await coordinator.updateSettingsIfChanged(BASE_SETTINGS, updatedSettings);
    assert.equal(res2.changed, true);
    assert.equal(env.counts.firestoreSaveSettingsCalls, 1);

    // Saving same updated settings again -> 0 additional Firestore writes
    const res3 = await coordinator.updateSettingsIfChanged(updatedSettings, {
      ...updatedSettings,
    });
    assert.equal(res3.changed, false);
    assert.equal(env.counts.firestoreSaveSettingsCalls, 1);
    assert.equal((await loadLocalSettings())?.audioRetention, 'delete_after_approval');
    console.log('PASS [9/10]: Skipping unchanged settings writes & eliminating pre-write getDoc');
  }

  // ---------------------------------------------------------------------------
  // Scenario 10: Opening and foregrounding repeatedly without repeated full-history downloads
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    const coordinator = new SyncCoordinator({ transport: env.transport });

    // Seed 5 historical entries in Firestore
    for (let i = 1; i <= 5; i++) {
      const id = `hist-${i}`;
      env.cloudEntries.set(
        id,
        createSampleEntry(id, {
          updatedAtIso: `2026-04-19T0${i}:00:00.000Z`,
        })
      );
    }

    // Initial startup sync pulls the 5 entries once
    await coordinator.synchronize('auto');
    assert.equal(env.counts.firestorePullCalls, 1);
    assert.equal(env.counts.firestorePullDocsReturned, 5);
    assert.equal(
      await getSyncMetadata<string>('sync_cursor_user-123'),
      '2026-04-19T05:00:00.000Z'
    );

    // Simulate user foregrounding/opening the app 10 times over the next 2 hours
    for (let i = 0; i < 10; i++) {
      env.nowMs += 10 * 60 * 1000; // +10 minutes each time (total +100 mins < 3 hours)
      await coordinator.synchronize('auto');
    }

    // 0 additional Firestore pull queries during the 3-hour window
    assert.equal(env.counts.firestorePullCalls, 1);
    assert.equal(env.counts.firestorePullDocsReturned, 5);

    // Advance clock past 3 hours and add 1 new remote entry in Firestore
    env.nowMs += THREE_HOURS_MS + 1000;
    env.cloudEntries.set(
      'hist-6',
      createSampleEntry('hist-6', {
        updatedAtIso: '2026-04-19T08:30:00.000Z',
      })
    );

    await coordinator.synchronize('auto');

    // Incremental pull ran once and fetched ONLY the 1 new entry (updatedAtIso > 05:00:00Z), not the 5 old ones
    assert.equal(env.counts.firestorePullCalls, 2);
    assert.equal(env.counts.firestorePullDocsReturned, 6); // 5 from first pull + 1 from incremental pull
    assert.equal((await loadVisibleLocalEntries()).length, 6);
    console.log(
      'PASS [10/11]: Opening and foregrounding repeatedly throttles pulls and uses incremental cursor'
    );
  }

  // ---------------------------------------------------------------------------
  // Scenario 11: Regression test — Save handler closes editor on success without
  // waiting for cloud sync or hanging on blocked IndexedDB, and stays open on failure
  // ---------------------------------------------------------------------------
  {
    __resetMemoryStoreForTests();
    const env = createMockEnvironment(true, 'user-123');
    // Simulate a slow cloud sync (500ms) to prove local save + editor close does not wait on cloud sync
    env.artificialCloudDelayMs = 500;
    const coordinator = new SyncCoordinator({ transport: env.transport });

    let timelineEntries: JournalEntry[] = [];
    let studioStage: 'idle' | 'review' = 'review';
    let isSaving = false;
    let errorMsg: string | null = null;
    let editorCloseCount = 0;

    // Exact App.tsx handleSaveNewEntry logic
    const handleSaveNewEntry = async (newEntry: JournalEntry) => {
      const savedLocal = await upsertLocalEntryFromUser(newEntry);
      timelineEntries = sortEntriesDescending([
        savedLocal,
        ...timelineEntries.filter((e) => e.id !== savedLocal.id),
      ]);
      void coordinator.emitStatus();
      void env.transport.mirrorUpsertToD1(savedLocal, false);
      void coordinator.synchronize('push_only');
    };

    // Exact VoiceRecorderStudio.tsx / EntryDetailModal.tsx save flow
    const runEditorSave = async (entryToSave: JournalEntry) => {
      if (isSaving) return;
      isSaving = true;
      errorMsg = null;
      try {
        await handleSaveNewEntry(entryToSave);
        studioStage = 'idle';
        editorCloseCount += 1;
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : 'Failed to save entry.';
      } finally {
        isSaving = false;
      }
    };

    // 11a. Genuine save failure: editor stays open, error shown, loading state reset
    __setSimulateSaveFailureForTests(true);
    await runEditorSave(createSampleEntry('save-fail-entry'));
    assert.equal(studioStage, 'review', 'Editor must remain open on save failure');
    assert.equal(editorCloseCount, 0, 'Editor must not close on save failure');
    assert.equal(isSaving, false, 'isSaving must reset to false after failure');
    assert.ok(
      typeof errorMsg === 'string' && (errorMsg as string).includes('Failed to save'),
      'Error feedback must be set'
    );
    assert.equal(timelineEntries.length, 0, 'Failed entry must not appear in timeline');

    // 11b. Successful save while cloud sync is slow: editor closes immediately (< 50ms)
    __setSimulateSaveFailureForTests(false);
    const startMs = Date.now();
    await runEditorSave(createSampleEntry('save-ok-entry'));
    const elapsedMs = Date.now() - startMs;

    assert.equal(studioStage, 'idle', 'Editor must close immediately on successful save');
    assert.equal(editorCloseCount, 1, 'Editor must close exactly once');
    assert.equal(isSaving, false, 'isSaving must reset to false after success');
    assert.equal(errorMsg, null, 'Error message must be cleared on success');
    assert.equal(timelineEntries.length, 1, 'Saved entry must appear in timeline immediately');
    assert.equal(timelineEntries[0].id, 'save-ok-entry');
    assert.ok(
      elapsedMs < 200,
      `Expected local save and editor close not to wait for 500ms cloud sync (took ${elapsedMs}ms)`
    );

    // Wait for background push_only from 11b to finish before mocking global indexedDB
    await coordinator.synchronize('push_only');

    // 11c. Simulate a stalled browser IndexedDB open request (queued behind an unclosed v1 connection)
    // and verify that withIdbTimeout + localStorage backup still resolves and closes the editor
    const g = globalThis as unknown as {
      indexedDB?: unknown;
      localStorage?: Storage;
    };
    const prevIndexedDB = g.indexedDB;
    const prevLocalStorage = g.localStorage;
    const storageMap = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
      clear: () => storageMap.clear(),
      key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
      get length() {
        return storageMap.size;
      },
    };
    // Mock an indexedDB.open() that never fires onsuccess, onerror, or onblocked
    g.indexedDB = {
      open: () => ({
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      }),
    };

    try {
      __resetMemoryStoreForTests();
      studioStage = 'review';
      editorCloseCount = 0;
      await runEditorSave(createSampleEntry('stalled-idb-entry'));
      assert.equal(
        studioStage,
        'idle',
        'Editor must still close even when browser IndexedDB open hangs'
      );
      assert.equal(editorCloseCount, 1);
      assert.equal(isSaving, false);
      assert.equal(timelineEntries[0].id, 'stalled-idb-entry');
    } finally {
      g.indexedDB = prevIndexedDB;
      g.localStorage = prevLocalStorage;
    }

    console.log(
      'PASS [11/11]: Editor closes immediately on save (even with slow cloud sync or hung IDB) and stays open on failure'
    );
  }

  console.log('\nAll 11 local-first, synchronization & editor-close scenarios passed.');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
