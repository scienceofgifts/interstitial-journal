import { ActiveDraft, JournalEntry, UserSettings } from '../types/journal';

const DB_NAME = 'cadence_journal_db';
const DB_VERSION = 2;
const DRAFT_STORE = 'active_drafts';
const AUDIO_CACHE_STORE = 'audio_blobs';
const ENTRIES_STORE = 'journal_entries';
const SYNC_META_STORE = 'sync_metadata';
const LOCAL_STORAGE_ENTRIES_KEY = 'interstitial_entries_backup_v2';
const IDB_TIMEOUT_MS = 1500;

// In-memory fallback stores for non-browser / automated test environments
const memoryDraftStore = new Map<string, ActiveDraft>();
const memoryAudioStore = new Map<
  string,
  { audioId: string; blob: Blob; mimeType: string; savedAt: number }
>();
const memoryEntriesStore = new Map<string, JournalEntry>();
const memorySyncMetaStore = new Map<string, unknown>();

let cachedDb: IDBDatabase | null = null;
let cachedDbPromise: Promise<IDBDatabase> | null = null;
let idbUnavailableUntilMs = 0;
let simulateSaveFailureForTests = false;

function hasIndexedDB(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    indexedDB !== null &&
    Date.now() >= idbUnavailableUntilMs
  );
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function readLocalStorageEntriesBackup(): JournalEntry[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_ENTRIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalStorageEntriesBackup(entries: JournalEntry[]): boolean {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(LOCAL_STORAGE_ENTRIES_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function __resetMemoryStoreForTests(): void {
  memoryDraftStore.clear();
  memoryAudioStore.clear();
  memoryEntriesStore.clear();
  memorySyncMetaStore.clear();
  simulateSaveFailureForTests = false;
  idbUnavailableUntilMs = 0;
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {}
    cachedDb = null;
  }
  cachedDbPromise = null;
  if (hasLocalStorage()) {
    try {
      localStorage.removeItem(LOCAL_STORAGE_ENTRIES_KEY);
    } catch {}
  }
}

export function __setSimulateSaveFailureForTests(shouldFail: boolean): void {
  simulateSaveFailureForTests = shouldFail;
}

function withIdbTimeout<T>(promise: Promise<T>, timeoutMs = IDB_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`IndexedDB operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDB()) {
    return Promise.reject(new Error('IndexedDB is not available right now.'));
  }

  if (cachedDb) {
    return Promise.resolve(cachedDb);
  }

  if (cachedDbPromise) {
    return cachedDbPromise;
  }

  const rawOpenPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Preserve existing v1 object stores without clearing or altering data
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AUDIO_CACHE_STORE)) {
        db.createObjectStore(AUDIO_CACHE_STORE, { keyPath: 'audioId' });
      }
      // v2 additions: durable journal_entries and sync_metadata stores
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        db.createObjectStore(ENTRIES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SYNC_META_STORE)) {
        db.createObjectStore(SYNC_META_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
        if (cachedDb === db) {
          cachedDb = null;
          cachedDbPromise = null;
        }
      };
      db.onclose = () => {
        if (cachedDb === db) {
          cachedDb = null;
          cachedDbPromise = null;
        }
      };
      if (settled) {
        try {
          db.close();
        } catch {}
        return;
      }
      settled = true;
      idbUnavailableUntilMs = 0;
      cachedDb = db;
      resolve(db);
    };

    request.onerror = () => {
      settled = true;
      cachedDbPromise = null;
      idbUnavailableUntilMs = Date.now() + 30_000;
      reject(request.error || new Error('Failed to open IndexedDB.'));
    };

    request.onblocked = () => {
      settled = true;
      cachedDbPromise = null;
      idbUnavailableUntilMs = Date.now() + 30_000;
      reject(new Error('IndexedDB upgrade blocked by an open connection.'));
    };
  });

  cachedDbPromise = withIdbTimeout(rawOpenPromise, IDB_TIMEOUT_MS).catch((err) => {
    cachedDbPromise = null;
    idbUnavailableUntilMs = Date.now() + 30_000;
    throw err;
  });

  return cachedDbPromise;
}

export function stripLocalSyncMetadata(entry: JournalEntry): JournalEntry {
  return {
    id: entry.id,
    ownerId: entry.ownerId,
    rawTranscription: entry.rawTranscription,
    cleanedTranscription: entry.cleanedTranscription,
    finalText: entry.finalText,
    cleanupMode: entry.cleanupMode,
    ambiguityNotes: entry.ambiguityNotes,
    audioId: entry.audioId,
    audioMimeType: entry.audioMimeType,
    audioDurationSec: entry.audioDurationSec,
    dateKey: entry.dateKey,
    createdAtIso: entry.createdAtIso,
    updatedAtIso: entry.updatedAtIso,
  };
}

export function isTombstoneEntry(entry: JournalEntry): boolean {
  return (
    entry.syncStatus === 'pending_delete' || entry.syncStatus === 'deleted_synced'
  );
}

export function sortEntriesDescending(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort(
    (a, b) =>
      new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
  );
}

function hydrateMemoryFromLocalStorageIfNeeded(): void {
  if (memoryEntriesStore.size > 0) return;
  const backup = readLocalStorageEntriesBackup();
  for (const item of backup) {
    if (item && item.id) {
      memoryEntriesStore.set(item.id, { ...item });
    }
  }
}

export async function loadAllLocalEntryRecords(): Promise<JournalEntry[]> {
  hydrateMemoryFromLocalStorageIfNeeded();

  if (!hasIndexedDB()) {
    return Array.from(memoryEntriesStore.values()).map((e) => ({ ...e }));
  }

  try {
    const db = await openDatabase();
    const idbRecords = await withIdbTimeout(
      new Promise<JournalEntry[]>((resolve, reject) => {
        const tx = db.transaction(ENTRIES_STORE, 'readonly');
        const store = tx.objectStore(ENTRIES_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );

    // Merge IndexedDB records with any newer in-memory / localStorage backup records
    for (const item of idbRecords) {
      if (!item || !item.id) continue;
      const mem = memoryEntriesStore.get(item.id);
      if (!mem) {
        memoryEntriesStore.set(item.id, { ...item });
      } else {
        const idbTime = new Date(item.updatedAtIso).getTime();
        const memTime = new Date(mem.updatedAtIso).getTime();
        if (idbTime > memTime) {
          memoryEntriesStore.set(item.id, { ...item });
        }
      }
    }

    const merged = Array.from(memoryEntriesStore.values()).map((e) => ({ ...e }));
    writeLocalStorageEntriesBackup(merged);
    return merged;
  } catch (err) {
    console.warn('Could not load local journal entries from IndexedDB:', err);
    return Array.from(memoryEntriesStore.values()).map((e) => ({ ...e }));
  }
}

export async function loadVisibleLocalEntries(): Promise<JournalEntry[]> {
  const all = await loadAllLocalEntryRecords();
  const visible = all.filter((e) => !isTombstoneEntry(e));
  return sortEntriesDescending(visible);
}

export async function getPendingSyncCount(): Promise<number> {
  const all = await loadAllLocalEntryRecords();
  return all.filter(
    (e) => e.syncStatus === 'pending_upsert' || e.syncStatus === 'pending_delete'
  ).length;
}

export async function saveLocalEntryRecord(entry: JournalEntry): Promise<JournalEntry> {
  if (simulateSaveFailureForTests) {
    throw new Error('Failed to save entry to persistent database.');
  }

  hydrateMemoryFromLocalStorageIfNeeded();
  const copy: JournalEntry = { ...entry };
  memoryEntriesStore.set(copy.id, copy);
  const savedToLocalStorage = writeLocalStorageEntriesBackup(
    Array.from(memoryEntriesStore.values())
  );

  if (!hasIndexedDB()) {
    return copy;
  }

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(ENTRIES_STORE, 'readwrite');
        const store = tx.objectStore(ENTRIES_STORE);
        store.put(copy);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch (err) {
    console.warn('Could not persist journal entry to IndexedDB:', err);
    if (!savedToLocalStorage) {
      memoryEntriesStore.delete(copy.id);
      throw err instanceof Error
        ? err
        : new Error('Failed to save entry to local storage.');
    }
  }
  return copy;
}

export async function saveLocalEntryRecordsBatch(entries: JournalEntry[]): Promise<void> {
  if (entries.length === 0) return;
  hydrateMemoryFromLocalStorageIfNeeded();
  for (const e of entries) {
    memoryEntriesStore.set(e.id, { ...e });
  }
  writeLocalStorageEntriesBackup(Array.from(memoryEntriesStore.values()));

  if (!hasIndexedDB()) return;

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(ENTRIES_STORE, 'readwrite');
        const store = tx.objectStore(ENTRIES_STORE);
        for (const entry of entries) {
          store.put({ ...entry });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch (err) {
    console.warn('Could not batch-save journal entries to IndexedDB:', err);
  }
}

export async function upsertLocalEntryFromUser(entry: JournalEntry): Promise<JournalEntry> {
  if (simulateSaveFailureForTests) {
    throw new Error('Failed to save entry to persistent database.');
  }

  hydrateMemoryFromLocalStorageIfNeeded();
  let existing = memoryEntriesStore.get(entry.id);
  if (!existing && memoryEntriesStore.size === 0) {
    const all = await loadAllLocalEntryRecords();
    existing = all.find((e) => e.id === entry.id);
  }

  const record: JournalEntry = {
    ...entry,
    createdAtIso: existing?.createdAtIso || entry.createdAtIso,
    dateKey: existing?.dateKey || entry.dateKey,
    syncStatus: 'pending_upsert',
    cloudSynced: existing?.cloudSynced ?? entry.cloudSynced ?? false,
    lastSyncedUpdatedAtIso:
      existing?.lastSyncedUpdatedAtIso ?? entry.lastSyncedUpdatedAtIso,
    deletedAtIso: undefined,
  };

  return saveLocalEntryRecord(record);
}

export async function markLocalEntryDeleted(
  entryId: string,
  deletedAtIso: string = new Date().toISOString()
): Promise<JournalEntry | null> {
  const all = await loadAllLocalEntryRecords();
  const existing = all.find((e) => e.id === entryId);

  const tombstone: JournalEntry = existing
    ? {
        ...existing,
        updatedAtIso: deletedAtIso,
        deletedAtIso,
        syncStatus: 'pending_delete',
      }
    : {
        id: entryId,
        ownerId: 'local',
        rawTranscription: '',
        cleanedTranscription: '',
        finalText: '[deleted]',
        cleanupMode: 'none',
        ambiguityNotes: '',
        audioId: '',
        audioMimeType: '',
        audioDurationSec: 0,
        dateKey: deletedAtIso.slice(0, 10),
        createdAtIso: deletedAtIso,
        updatedAtIso: deletedAtIso,
        deletedAtIso,
        syncStatus: 'pending_delete',
        cloudSynced: false,
      };

  await saveLocalEntryRecord(tombstone);
  return existing || tombstone;
}

export interface MergeRemoteResult {
  visibleEntries: JournalEntry[];
  newlyImportedFromD1: JournalEntry[];
  updatedFromCloud: JournalEntry[];
  staleD1DeletedIds: string[];
}

export async function mergeRemoteEntriesIntoLocal(
  remoteEntries: JournalEntry[],
  source: 'd1' | 'firestore'
): Promise<MergeRemoteResult> {
  const allLocal = await loadAllLocalEntryRecords();
  const byId = new Map<string, JournalEntry>();
  for (const item of allLocal) {
    byId.set(item.id, item);
  }

  const toPersist: JournalEntry[] = [];
  const newlyImportedFromD1: JournalEntry[] = [];
  const updatedFromCloud: JournalEntry[] = [];
  const staleD1DeletedIds: string[] = [];

  for (const rawRemote of remoteEntries) {
    if (!rawRemote || !rawRemote.id) continue;
    const remote = stripLocalSyncMetadata(rawRemote);
    const local = byId.get(remote.id);

    // 1. Tombstone check: never resurrect an entry deleted locally
    if (local && isTombstoneEntry(local)) {
      const tombstoneTime = new Date(
        local.deletedAtIso || local.updatedAtIso
      ).getTime();
      const remoteTime = new Date(remote.updatedAtIso).getTime();

      if (source === 'd1') {
        staleD1DeletedIds.push(remote.id);
        continue;
      }

      // For Firestore: if pending_delete, never resurrect. If deleted_synced, only restore if remote was explicitly modified after the deletion.
      if (
        local.syncStatus === 'pending_delete' ||
        !Number.isFinite(remoteTime) ||
        remoteTime <= tombstoneTime
      ) {
        continue;
      }
    }

    // 2. New record not yet in IndexedDB
    if (!local) {
      if (source === 'firestore') {
        const syncedRecord: JournalEntry = {
          ...remote,
          syncStatus: 'synced',
          cloudSynced: true,
          lastSyncedUpdatedAtIso: remote.updatedAtIso,
        };
        byId.set(remote.id, syncedRecord);
        toPersist.push(syncedRecord);
        updatedFromCloud.push(syncedRecord);
      } else {
        // Imported from D1 (/api/entries) during initial migration/startup.
        // Mark as pending_upsert so existing D1 notes are preserved and synced to Firestore when authenticated.
        const migratedRecord: JournalEntry = {
          ...remote,
          syncStatus: 'pending_upsert',
          cloudSynced: false,
        };
        byId.set(remote.id, migratedRecord);
        toPersist.push(migratedRecord);
        newlyImportedFromD1.push(migratedRecord);
      }
      continue;
    }

    // 3. Existing local entry has unsynchronized changes (pending_upsert)
    if (local.syncStatus === 'pending_upsert') {
      if (source === 'd1') {
        // Local IndexedDB is authoritative over D1
        continue;
      }

      // Source is Firestore: never silently overwrite unsynchronized local text
      const sameContent =
        local.finalText.trim() === remote.finalText.trim() &&
        local.cleanedTranscription.trim() === remote.cleanedTranscription.trim();

      const localTime = new Date(local.updatedAtIso).getTime();
      const remoteTime = new Date(remote.updatedAtIso).getTime();
      const baseTime = local.lastSyncedUpdatedAtIso
        ? new Date(local.lastSyncedUpdatedAtIso).getTime()
        : 0;

      if (sameContent && remoteTime >= localTime) {
        const converged: JournalEntry = {
          ...remote,
          syncStatus: 'synced',
          cloudSynced: true,
          lastSyncedUpdatedAtIso: remote.updatedAtIso,
        };
        byId.set(remote.id, converged);
        toPersist.push(converged);
        continue;
      }

      if (!sameContent && remoteTime > baseTime && remoteTime > localTime) {
        // Simultaneous edit on another device while local had pending changes.
        // Preserve local.finalText as primary and record remote revision in ambiguityNotes so zero text is lost.
        const conflictHeader = `[Synced cloud revision (${remote.updatedAtIso})]: ${remote.finalText}`;
        const existingNotes = local.ambiguityNotes || '';
        const mergedNotes = existingNotes.includes(remote.finalText)
          ? existingNotes
          : existingNotes
          ? `${existingNotes}\n${conflictHeader}`
          : conflictHeader;

        const mergedBumpIso = new Date(
          Math.max(Date.now(), remoteTime + 1)
        ).toISOString();

        const conflictPreserved: JournalEntry = {
          ...local,
          ownerId: remote.ownerId || local.ownerId,
          createdAtIso: remote.createdAtIso || local.createdAtIso,
          dateKey: remote.dateKey || local.dateKey,
          ambiguityNotes: mergedNotes.slice(0, 5000),
          updatedAtIso: mergedBumpIso,
          syncStatus: 'pending_upsert',
          cloudSynced: true,
          lastSyncedUpdatedAtIso: remote.updatedAtIso,
        };
        byId.set(remote.id, conflictPreserved);
        toPersist.push(conflictPreserved);
      } else {
        // Remote is an older snapshot of the document we edited locally; mark that it exists in cloud so updateDoc is used
        if (!local.cloudSynced || local.lastSyncedUpdatedAtIso !== remote.updatedAtIso) {
          const updatedMeta: JournalEntry = {
            ...local,
            ownerId: remote.ownerId || local.ownerId,
            createdAtIso: remote.createdAtIso || local.createdAtIso,
            dateKey: remote.dateKey || local.dateKey,
            cloudSynced: true,
            lastSyncedUpdatedAtIso: remote.updatedAtIso,
          };
          byId.set(remote.id, updatedMeta);
          toPersist.push(updatedMeta);
        }
      }
      continue;
    }

    // 4. Existing local entry is already 'synced'
    const localTime = new Date(local.updatedAtIso).getTime();
    const remoteTime = new Date(remote.updatedAtIso).getTime();

    if (source === 'firestore') {
      if (
        !local.cloudSynced ||
        remoteTime > localTime ||
        (remoteTime === localTime && local.finalText !== remote.finalText)
      ) {
        const updatedRecord: JournalEntry = {
          ...remote,
          syncStatus: 'synced',
          cloudSynced: true,
          lastSyncedUpdatedAtIso: remote.updatedAtIso,
        };
        byId.set(remote.id, updatedRecord);
        toPersist.push(updatedRecord);
        updatedFromCloud.push(updatedRecord);
      }
    } else if (source === 'd1' && !local.cloudSynced && remoteTime > localTime) {
      const updatedFromD1: JournalEntry = {
        ...remote,
        syncStatus: 'pending_upsert',
        cloudSynced: false,
      };
      byId.set(remote.id, updatedFromD1);
      toPersist.push(updatedFromD1);
    }
  }

  if (toPersist.length > 0) {
    await saveLocalEntryRecordsBatch(toPersist);
  }

  const visibleEntries = sortEntriesDescending(
    Array.from(byId.values()).filter((e) => !isTombstoneEntry(e))
  );

  return {
    visibleEntries,
    newlyImportedFromD1,
    updatedFromCloud,
    staleD1DeletedIds,
  };
}

export async function getSyncMetadata<T>(key: string): Promise<T | null> {
  if (!hasIndexedDB()) {
    return (memorySyncMetaStore.get(key) as T) ?? null;
  }
  try {
    const db = await openDatabase();
    const val = await withIdbTimeout(
      new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(SYNC_META_STORE, 'readonly');
        const store = tx.objectStore(SYNC_META_STORE);
        const req = store.get(key);
        req.onsuccess = () =>
          resolve(req.result && 'value' in req.result ? (req.result.value as T) : null);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
    if (val !== null) {
      memorySyncMetaStore.set(key, val);
    }
    return val ?? ((memorySyncMetaStore.get(key) as T) ?? null);
  } catch {
    return (memorySyncMetaStore.get(key) as T) ?? null;
  }
}

export async function setSyncMetadata<T>(key: string, value: T): Promise<void> {
  memorySyncMetaStore.set(key, value);
  if (!hasIndexedDB()) return;

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SYNC_META_STORE, 'readwrite');
        const store = tx.objectStore(SYNC_META_STORE);
        store.put({ key, value, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch {
    // ignore
  }
}

export async function loadLocalSettings(): Promise<UserSettings | null> {
  return getSyncMetadata<UserSettings>('user_settings');
}

export async function saveLocalSettings(settings: UserSettings): Promise<void> {
  await setSyncMetadata<UserSettings>('user_settings', settings);
}

export async function saveActiveDraft(draft: ActiveDraft): Promise<void> {
  memoryDraftStore.set('current_draft', { ...draft, id: 'current_draft' });
  if (!hasIndexedDB()) return;

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE, 'readwrite');
        const store = tx.objectStore(DRAFT_STORE);
        store.put({ ...draft, id: 'current_draft' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch (err) {
    console.warn('Could not persist local draft:', err);
  }
}

export async function loadActiveDraft(): Promise<ActiveDraft | null> {
  if (!hasIndexedDB()) {
    return memoryDraftStore.get('current_draft') || null;
  }
  try {
    const db = await openDatabase();
    return await withIdbTimeout(
      new Promise<ActiveDraft | null>((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE, 'readonly');
        const store = tx.objectStore(DRAFT_STORE);
        const req = store.get('current_draft');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch {
    return memoryDraftStore.get('current_draft') || null;
  }
}

export async function clearActiveDraft(): Promise<void> {
  memoryDraftStore.delete('current_draft');
  if (!hasIndexedDB()) return;

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DRAFT_STORE, 'readwrite');
        const store = tx.objectStore(DRAFT_STORE);
        store.delete('current_draft');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch {
    // ignore
  }
}

export async function cacheLocalAudioBlob(
  audioId: string,
  blob: Blob,
  mimeType: string
): Promise<void> {
  if (!audioId) return;
  memoryAudioStore.set(audioId, { audioId, blob, mimeType, savedAt: Date.now() });
  if (!hasIndexedDB()) return;

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(AUDIO_CACHE_STORE, 'readwrite');
        const store = tx.objectStore(AUDIO_CACHE_STORE);
        store.put({ audioId, blob, mimeType, savedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch {
    // ignore
  }
}

export async function getCachedLocalAudioBlob(audioId: string): Promise<Blob | null> {
  if (!audioId) return null;
  if (!hasIndexedDB()) {
    return memoryAudioStore.get(audioId)?.blob || null;
  }
  try {
    const db = await openDatabase();
    const idbBlob = await withIdbTimeout(
      new Promise<Blob | null>((resolve, reject) => {
        const tx = db.transaction(AUDIO_CACHE_STORE, 'readonly');
        const store = tx.objectStore(AUDIO_CACHE_STORE);
        const req = store.get(audioId);
        req.onsuccess = () => resolve(req.result?.blob || null);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
    return idbBlob || memoryAudioStore.get(audioId)?.blob || null;
  } catch {
    return memoryAudioStore.get(audioId)?.blob || null;
  }
}

export async function deleteCachedLocalAudioBlob(audioId: string): Promise<void> {
  if (!audioId) return;
  memoryAudioStore.delete(audioId);
  if (!hasIndexedDB()) return;

  try {
    const db = await openDatabase();
    await withIdbTimeout(
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(AUDIO_CACHE_STORE, 'readwrite');
        const store = tx.objectStore(AUDIO_CACHE_STORE);
        store.delete(audioId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
      IDB_TIMEOUT_MS
    );
  } catch {
    // ignore
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
