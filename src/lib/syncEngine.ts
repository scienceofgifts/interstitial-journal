import {
  areSettingsEqual,
  JournalEntry,
  SyncStateSummary,
  UserSettings,
} from '../types/journal';
import {
  getPendingSyncCount,
  getSyncMetadata,
  loadAllLocalEntryRecords,
  loadLocalSettings,
  loadVisibleLocalEntries,
  mergeRemoteEntriesIntoLocal,
  saveLocalEntryRecord,
  saveLocalSettings,
  setSyncMetadata,
  stripLocalSyncMetadata,
} from './draftStorage';
import {
  deleteEntryFromFirestore,
  fetchEntriesFromFirestore,
  FetchFirestoreEntriesOptions,
  saveUserSettingsToFirestore,
  upsertEntryInFirestore,
} from './firebase';

export const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

export type SyncTriggerMode = 'push_only' | 'auto' | 'manual';

export interface SyncTransportAdapter {
  isOnline: () => boolean;
  getCurrentUid: () => string | null;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  upsertCloudEntry: (entry: JournalEntry, knownCloudSynced: boolean) => Promise<JournalEntry>;
  deleteCloudEntry: (entryId: string) => Promise<void>;
  fetchCloudEntries: (
    options: FetchFirestoreEntriesOptions
  ) => Promise<{ entries: JournalEntry[]; latestCursorIso: string | null }>;
  saveCloudSettings: (settings: UserSettings) => Promise<void>;
  mirrorUpsertToD1: (entry: JournalEntry, isUpdate: boolean) => Promise<void>;
  mirrorDeleteToD1: (entryId: string) => Promise<void>;
  fetchD1Entries: () => Promise<JournalEntry[]>;
}

export async function defaultMirrorUpsertToD1(
  entry: JournalEntry,
  isUpdate: boolean
): Promise<void> {
  if (typeof fetch === 'undefined') return;
  const clean = stripLocalSyncMetadata(entry);
  try {
    if (isUpdate) {
      const res = await fetch(`/api/entries/${encodeURIComponent(clean.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean),
      });
      if (res.status === 404) {
        await fetch('/api/entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clean),
        });
      }
    } else {
      await fetch('/api/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean),
      });
    }
  } catch {
    // Non-fatal: local IndexedDB is authoritative and durable offline
  }
}

export async function defaultMirrorDeleteToD1(entryId: string): Promise<void> {
  if (typeof fetch === 'undefined') return;
  try {
    await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
      method: 'DELETE',
    });
  } catch {
    // Non-fatal offline
  }
}

export async function defaultFetchD1Entries(): Promise<JournalEntry[]> {
  if (typeof fetch === 'undefined') return [];
  try {
    const res = await fetch('/api/entries');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function isPermanentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code || '';
  return (
    code === 'permission-denied' ||
    code === 'unauthenticated' ||
    code === 'invalid-argument' ||
    code === 'failed-precondition' ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('UNAUTHENTICATED') ||
    msg.includes('requires an index')
  );
}

export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleepFn =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= maxRetries || isPermanentError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      attempt += 1;
      await sleepFn(delay);
    }
  }
}

export interface SyncRunResult {
  visibleEntries: JournalEntry[];
  summary: SyncStateSummary;
  pushedUpserts: number;
  pushedDeletes: number;
  pulledEntries: number;
  didPullFromCloud: boolean;
}

export interface SyncCoordinatorOptions {
  transport?: Partial<SyncTransportAdapter>;
  pullIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  onStateChange?: (summary: SyncStateSummary, visibleEntries?: JournalEntry[]) => void;
}

export class SyncCoordinator {
  private transport: SyncTransportAdapter;
  private pullIntervalMs: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;
  private onStateChange?: (
    summary: SyncStateSummary,
    visibleEntries?: JournalEntry[]
  ) => void;

  private activeSyncPromise: Promise<SyncRunResult> | null = null;
  private queuedMode: SyncTriggerMode | null = null;
  private lastErrorMessage: string | null = null;

  constructor(options: SyncCoordinatorOptions = {}) {
    this.pullIntervalMs = options.pullIntervalMs ?? THREE_HOURS_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.onStateChange = options.onStateChange;

    this.transport = {
      isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
      getCurrentUid: () => null,
      nowMs: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      upsertCloudEntry: (entry, knownCloudSynced) =>
        upsertEntryInFirestore(entry, knownCloudSynced),
      deleteCloudEntry: (entryId) => deleteEntryFromFirestore(entryId),
      fetchCloudEntries: (fetchOpts) => fetchEntriesFromFirestore(fetchOpts),
      saveCloudSettings: (settings) => saveUserSettingsToFirestore(settings),
      mirrorUpsertToD1: defaultMirrorUpsertToD1,
      mirrorDeleteToD1: defaultMirrorDeleteToD1,
      fetchD1Entries: defaultFetchD1Entries,
      ...options.transport,
    };
  }

  public setCurrentUidGetter(getter: () => string | null): void {
    this.transport.getCurrentUid = getter;
  }

  public async getSummary(isSyncingOverride?: boolean): Promise<SyncStateSummary> {
    const pendingCount = await getPendingSyncCount();
    const lastSyncedAtIso = await getSyncMetadata<string>('sync_last_success_iso');

    const isSyncing =
      isSyncingOverride !== undefined ? isSyncingOverride : Boolean(this.activeSyncPromise);

    let state: SyncStateSummary['state'] = 'idle';
    if (isSyncing) {
      state = 'syncing';
    } else if (this.lastErrorMessage) {
      state = 'error';
    } else if (pendingCount > 0) {
      state = 'pending';
    } else if (lastSyncedAtIso) {
      state = 'synced';
    } else {
      state = 'idle';
    }

    return {
      state,
      pendingCount,
      lastSyncedAtIso: lastSyncedAtIso || null,
      errorMessage: this.lastErrorMessage,
    };
  }

  public async emitStatus(
    visibleEntries?: JournalEntry[],
    isSyncingOverride?: boolean
  ): Promise<SyncStateSummary> {
    const summary = await this.getSummary(isSyncingOverride);
    this.onStateChange?.(summary, visibleEntries);
    return summary;
  }

  /**
   * Migrates/merges existing records from D1 (/api/entries) into local IndexedDB on startup
   * without overwriting any newer or unsynchronized local IndexedDB entries.
   */
  public async importInitialFromD1(): Promise<JournalEntry[]> {
    const d1Entries = await this.transport.fetchD1Entries();
    if (d1Entries.length === 0) {
      const visible = await loadVisibleLocalEntries();
      await this.emitStatus(visible);
      return visible;
    }

    const mergeResult = await mergeRemoteEntriesIntoLocal(d1Entries, 'd1');

    // Clean up any D1 entries that were already tombstoned locally
    for (const staleId of mergeResult.staleD1DeletedIds) {
      void this.transport.mirrorDeleteToD1(staleId);
    }

    await this.emitStatus(mergeResult.visibleEntries);
    return mergeResult.visibleEntries;
  }

  private mergeTriggerPriority(
    a: SyncTriggerMode | null,
    b: SyncTriggerMode
  ): SyncTriggerMode {
    if (!a) return b;
    if (a === 'manual' || b === 'manual') return 'manual';
    if (a === 'auto' || b === 'auto') return 'auto';
    return 'push_only';
  }

  /**
   * Serialized synchronization entry point.
   * Multiple concurrent triggers never run overlapping Firestore jobs.
   */
  public async synchronize(mode: SyncTriggerMode = 'auto'): Promise<SyncRunResult> {
    if (this.activeSyncPromise) {
      this.queuedMode = this.mergeTriggerPriority(this.queuedMode, mode);
      const currentResult = await this.activeSyncPromise;
      if (this.queuedMode) {
        const nextMode = this.queuedMode;
        this.queuedMode = null;
        return this.synchronize(nextMode);
      }
      return currentResult;
    }

    this.activeSyncPromise = this.executeSyncInternal(mode);
    try {
      const result = await this.activeSyncPromise;
      return result;
    } finally {
      this.activeSyncPromise = null;
      if (this.queuedMode) {
        const nextMode = this.queuedMode;
        this.queuedMode = null;
        void this.synchronize(nextMode);
      }
    }
  }

  private async executeSyncInternal(mode: SyncTriggerMode): Promise<SyncRunResult> {
    const uid = this.transport.getCurrentUid();
    const isOnline = this.transport.isOnline();

    let pushedUpserts = 0;
    let pushedDeletes = 0;
    let pulledEntries = 0;
    let didPullFromCloud = false;

    // If offline or not signed into Firebase, keep local changes queued safely in IndexedDB
    if (!isOnline || !uid) {
      const visibleEntries = await loadVisibleLocalEntries();
      const summary = await this.emitStatus(visibleEntries, false);
      return {
        visibleEntries,
        summary,
        pushedUpserts,
        pushedDeletes,
        pulledEntries,
        didPullFromCloud,
      };
    }

    await this.emitStatus(undefined, true);
    let encounteredError: string | null = null;

    try {
      // PHASE 1: Push pending local upserts and deletions
      const allRecords = await loadAllLocalEntryRecords();
      const pendingUpserts = allRecords.filter((e) => e.syncStatus === 'pending_upsert');
      const pendingDeletes = allRecords.filter((e) => e.syncStatus === 'pending_delete');

      for (const entry of pendingUpserts) {
        if (this.transport.getCurrentUid() !== uid) {
          throw new Error('Authentication state changed during synchronization.');
        }

        const entryWithOwner: JournalEntry = {
          ...entry,
          ownerId: uid,
        };

        const savedClean = await withBoundedRetry(
          () =>
            this.transport.upsertCloudEntry(
              entryWithOwner,
              Boolean(entry.cloudSynced)
            ),
          {
            maxRetries: this.maxRetries,
            baseDelayMs: this.retryBaseDelayMs,
            sleep: this.transport.sleep,
          }
        );

        // Verify entry wasn't edited again locally while the network request was in flight
        const latestLocalList = await loadAllLocalEntryRecords();
        const latestLocal = latestLocalList.find((e) => e.id === entry.id);

        if (
          latestLocal &&
          latestLocal.syncStatus === 'pending_upsert' &&
          latestLocal.updatedAtIso === entry.updatedAtIso &&
          latestLocal.finalText === entry.finalText
        ) {
          const syncedRecord: JournalEntry = {
            ...latestLocal,
            ownerId: uid,
            syncStatus: 'synced',
            cloudSynced: true,
            lastSyncedUpdatedAtIso: savedClean.updatedAtIso,
          };
          await saveLocalEntryRecord(syncedRecord);
          void this.transport.mirrorUpsertToD1(syncedRecord, true);
        } else if (latestLocal && latestLocal.syncStatus === 'pending_upsert') {
          // User edited the entry again while push was in flight: keep pending_upsert, but record that cloud doc now exists
          await saveLocalEntryRecord({
            ...latestLocal,
            ownerId: uid,
            cloudSynced: true,
            lastSyncedUpdatedAtIso: savedClean.updatedAtIso,
          });
        }

        pushedUpserts += 1;
      }

      for (const tombstone of pendingDeletes) {
        if (this.transport.getCurrentUid() !== uid) {
          throw new Error('Authentication state changed during synchronization.');
        }

        if (tombstone.cloudSynced !== false) {
          await withBoundedRetry(() => this.transport.deleteCloudEntry(tombstone.id), {
            maxRetries: this.maxRetries,
            baseDelayMs: this.retryBaseDelayMs,
            sleep: this.transport.sleep,
          });
        }

        void this.transport.mirrorDeleteToD1(tombstone.id);

        // Retain durable tombstone in 'deleted_synced' state so deleted entries never resurrect from stale sources
        await saveLocalEntryRecord({
          ...tombstone,
          syncStatus: 'deleted_synced',
          cloudSynced: false,
        });
        pushedDeletes += 1;
      }

      // PHASE 2: Determine whether a remote pull should run
      const initialPullDone = await getSyncMetadata<boolean>(`sync_initial_done_${uid}`);
      const lastPullMs = await getSyncMetadata<number>(`sync_last_pull_ms_${uid}`);
      const lastCursorIso = await getSyncMetadata<string>(`sync_cursor_${uid}`);
      const nowMs = this.transport.nowMs();

      const shouldPull =
        mode === 'manual' ||
        (mode === 'auto' &&
          (!initialPullDone ||
            !lastPullMs ||
            nowMs - lastPullMs >= this.pullIntervalMs));

      if (shouldPull) {
        didPullFromCloud = true;
        const sinceIso = initialPullDone ? lastCursorIso : null;

        await withBoundedRetry(
          async () => {
            await this.transport.fetchCloudEntries({
              uid,
              sinceUpdatedAtIso: sinceIso,
              pageSize: 100,
              onPage: async (pageEntries, pageCursorIso) => {
                if (this.transport.getCurrentUid() !== uid) {
                  throw new Error('Authentication state changed during cloud pull.');
                }

                const mergeRes = await mergeRemoteEntriesIntoLocal(
                  pageEntries,
                  'firestore'
                );
                pulledEntries += pageEntries.length;

                // Mirror newly pulled cloud entries to local D1 adapter in background
                for (const cloudUpdated of mergeRes.updatedFromCloud) {
                  void this.transport.mirrorUpsertToD1(cloudUpdated, true);
                }

                // Advance sync cursor ONLY after page changes are durably committed to IndexedDB
                const currentSavedCursor = await getSyncMetadata<string>(
                  `sync_cursor_${uid}`
                );
                if (!currentSavedCursor || pageCursorIso > currentSavedCursor) {
                  await setSyncMetadata(`sync_cursor_${uid}`, pageCursorIso);
                }
              },
            });
          },
          {
            maxRetries: this.maxRetries,
            baseDelayMs: this.retryBaseDelayMs,
            sleep: this.transport.sleep,
          }
        );

        // Also ensure cursor is at least the max updatedAtIso of any local synced entry for this user
        const afterPullRecords = await loadAllLocalEntryRecords();
        let maxSyncedIso = await getSyncMetadata<string>(`sync_cursor_${uid}`);
        for (const rec of afterPullRecords) {
          if (
            rec.syncStatus === 'synced' &&
            rec.cloudSynced &&
            (!maxSyncedIso || rec.updatedAtIso > maxSyncedIso)
          ) {
            maxSyncedIso = rec.updatedAtIso;
          }
        }
        if (maxSyncedIso) {
          await setSyncMetadata(`sync_cursor_${uid}`, maxSyncedIso);
        }

        await setSyncMetadata(`sync_initial_done_${uid}`, true);
        await setSyncMetadata(`sync_last_pull_ms_${uid}`, this.transport.nowMs());
      }

      const nowIso = new Date(this.transport.nowMs()).toISOString();
      if (pushedUpserts > 0 || pushedDeletes > 0 || didPullFromCloud) {
        await setSyncMetadata('sync_last_success_iso', nowIso);
      }
      this.lastErrorMessage = null;
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      encounteredError = rawMsg;
      this.lastErrorMessage = 'Sync failed · Retry';
    }

    const visibleEntries = await loadVisibleLocalEntries();
    const summary = await this.emitStatus(visibleEntries, false);
    if (encounteredError) {
      summary.state = 'error';
      summary.errorMessage = this.lastErrorMessage;
    }

    return {
      visibleEntries,
      summary,
      pushedUpserts,
      pushedDeletes,
      pulledEntries,
      didPullFromCloud,
    };
  }

  /**
   * Saves user settings locally and only writes to D1 / Firestore when values actually change.
   */
  public async updateSettingsIfChanged(
    currentSettings: UserSettings,
    nextSettings: UserSettings
  ): Promise<{ changed: boolean; settings: UserSettings }> {
    const persistedSettings = await loadLocalSettings();
    if (
      areSettingsEqual(currentSettings, nextSettings) &&
      persistedSettings &&
      areSettingsEqual(persistedSettings, nextSettings)
    ) {
      return { changed: false, settings: currentSettings };
    }

    await saveLocalSettings(nextSettings);

    if (typeof fetch !== 'undefined') {
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextSettings),
      }).catch(() => {});
    }

    const uid = this.transport.getCurrentUid();
    if (uid && this.transport.isOnline()) {
      void withBoundedRetry(() => this.transport.saveCloudSettings(nextSettings), {
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryBaseDelayMs,
        sleep: this.transport.sleep,
      }).catch((err) => {
        console.warn('Cloud settings sync warning:', err);
      });
    }

    return { changed: true, settings: nextSettings };
  }
}
