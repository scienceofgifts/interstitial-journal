import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
  serverTimestamp,
  Query,
  QueryConstraint,
  QueryDocumentSnapshot,
  DocumentData,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { JournalEntry, UserSettings } from '../types/journal';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await firebaseSignOut(auth);
}

export { onAuthStateChanged };
export type { User };

// Defensive payload sanitization adhering strictly to firebase-blueprint.json bounds
export function sanitizeEntryForFirestore(entry: JournalEntry, uid: string) {
  const safeId = entry.id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128) || 'entry_default';
  const safeDateKey = /^\d{4}-\d{2}-\d{2}$/.test(entry.dateKey)
    ? entry.dateKey
    : new Date().toISOString().slice(0, 10);

  return {
    id: safeId,
    ownerId: uid,
    rawTranscription: String(entry.rawTranscription || '').slice(0, 50000),
    cleanedTranscription: String(entry.cleanedTranscription || '').slice(0, 50000),
    finalText: String(entry.finalText || ' ').slice(0, 50000),
    cleanupMode: (['none', 'light', 'clean'].includes(entry.cleanupMode)
      ? entry.cleanupMode
      : 'none') as 'none' | 'light' | 'clean',
    ambiguityNotes: String(entry.ambiguityNotes || '').slice(0, 5000),
    audioId: String(entry.audioId || '').slice(0, 128),
    audioMimeType: String(entry.audioMimeType || '').slice(0, 64),
    audioDurationSec: Math.min(7200, Math.max(0, Number(entry.audioDurationSec) || 0)),
    dateKey: safeDateKey,
    createdAtIso: String(entry.createdAtIso || new Date().toISOString()).slice(0, 64),
    updatedAtIso: String(entry.updatedAtIso || new Date().toISOString()).slice(0, 64),
  };
}

export async function createEntryInFirestore(entry: JournalEntry): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const clean = sanitizeEntryForFirestore(entry, user.uid);
  const path = `entries/${clean.id}`;
  try {
    await setDoc(doc(db, 'entries', clean.id), {
      ...clean,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateEntryInFirestore(entry: JournalEntry): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const clean = sanitizeEntryForFirestore(entry, user.uid);
  const path = `entries/${clean.id}`;
  try {
    await updateDoc(doc(db, 'entries', clean.id), {
      rawTranscription: clean.rawTranscription,
      cleanedTranscription: clean.cleanedTranscription,
      finalText: clean.finalText,
      cleanupMode: clean.cleanupMode,
      ambiguityNotes: clean.ambiguityNotes,
      audioId: clean.audioId,
      audioMimeType: clean.audioMimeType,
      audioDurationSec: clean.audioDurationSec,
      updatedAtIso: clean.updatedAtIso,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

/**
 * Idempotent Firestore upsert that respects strict create vs. update rules in firestore.rules
 * without performing a pre-write getDoc() read.
 */
export async function upsertEntryInFirestore(
  entry: JournalEntry,
  knownCloudSynced: boolean = false
): Promise<JournalEntry> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) {
    throw new Error('User is not authenticated for cloud sync.');
  }

  const clean = sanitizeEntryForFirestore(entry, user.uid);
  const path = `entries/${clean.id}`;
  const docRef = doc(db, 'entries', clean.id);

  const mutableFields = {
    rawTranscription: clean.rawTranscription,
    cleanedTranscription: clean.cleanedTranscription,
    finalText: clean.finalText,
    cleanupMode: clean.cleanupMode,
    ambiguityNotes: clean.ambiguityNotes,
    audioId: clean.audioId,
    audioMimeType: clean.audioMimeType,
    audioDurationSec: clean.audioDurationSec,
    updatedAtIso: clean.updatedAtIso,
    updatedAt: serverTimestamp(),
  };

  if (knownCloudSynced) {
    try {
      await updateDoc(docRef, mutableFields);
      return clean;
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'not-found' || msg.includes('No document to update') || msg.includes('NOT_FOUND')) {
        try {
          await setDoc(docRef, {
            ...clean,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return clean;
        } catch (createErr) {
          handleFirestoreError(createErr, OperationType.CREATE, path);
        }
      }
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  } else {
    try {
      await setDoc(docRef, {
        ...clean,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return clean;
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      const msg = err instanceof Error ? err.message : String(err);
      // If document already exists in Firestore, setDoc is evaluated against the update rule
      // which forbids overwriting createdAt; fall back to updateDoc on mutable fields.
      if (code === 'permission-denied' || msg.includes('PERMISSION_DENIED') || msg.includes('insufficient permissions')) {
        try {
          await updateDoc(docRef, mutableFields);
          return clean;
        } catch (updateErr) {
          handleFirestoreError(updateErr, OperationType.UPDATE, path);
        }
      }
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  }
}

export async function deleteEntryFromFirestore(entryId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeId = entryId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
  const path = `entries/${safeId}`;
  try {
    await deleteDoc(doc(db, 'entries', safeId));
  } catch (error) {
    const code = (error as { code?: string })?.code || '';
    if (code === 'not-found') return;
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export interface FetchFirestoreEntriesOptions {
  uid: string;
  sinceUpdatedAtIso?: string | null;
  pageSize?: number;
  onPage?: (entries: JournalEntry[], pageCursorIso: string) => Promise<void>;
}

function docDataToJournalEntry(d: DocumentData): JournalEntry {
  return {
    id: String(d.id || ''),
    ownerId: String(d.ownerId || ''),
    rawTranscription: String(d.rawTranscription || ''),
    cleanedTranscription: String(d.cleanedTranscription || ''),
    finalText: String(d.finalText || ''),
    cleanupMode: (['none', 'light', 'clean'].includes(d.cleanupMode)
      ? d.cleanupMode
      : 'none') as 'none' | 'light' | 'clean',
    ambiguityNotes: String(d.ambiguityNotes || ''),
    audioId: String(d.audioId || ''),
    audioMimeType: String(d.audioMimeType || ''),
    audioDurationSec: Number(d.audioDurationSec) || 0,
    dateKey: String(d.dateKey || ''),
    createdAtIso: String(d.createdAtIso || new Date().toISOString()),
    updatedAtIso: String(d.updatedAtIso || new Date().toISOString()),
  };
}

/**
 * Fetches journal entries from Firestore using paginated, incremental delta queries
 * (`updatedAtIso > sinceUpdatedAtIso` ordered by `updatedAtIso ASC`).
 * Never uses a real-time listener and never falls back to full-collection reads on incremental sync.
 */
export async function fetchEntriesFromFirestore(
  options: FetchFirestoreEntriesOptions
): Promise<{ entries: JournalEntry[]; latestCursorIso: string | null }> {
  const { uid, sinceUpdatedAtIso, pageSize = 100, onPage } = options;
  const path = 'entries';
  const collected: JournalEntry[] = [];
  let latestCursorIso: string | null = sinceUpdatedAtIso || null;
  let lastDocSnap: QueryDocumentSnapshot<DocumentData> | null = null;

  try {
    while (true) {
      const constraints: QueryConstraint[] = [where('ownerId', '==', uid)];
      if (sinceUpdatedAtIso) {
        constraints.push(where('updatedAtIso', '>', sinceUpdatedAtIso));
      }

      const q: Query<DocumentData> = lastDocSnap
        ? query(
            collection(db, 'entries'),
            ...constraints,
            orderBy('updatedAtIso', 'asc'),
            startAfter(lastDocSnap),
            limit(pageSize)
          )
        : query(
            collection(db, 'entries'),
            ...constraints,
            orderBy('updatedAtIso', 'asc'),
            limit(pageSize)
          );

      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        break;
      }

      const pageEntries: JournalEntry[] = [];
      snapshot.docs.forEach((docSnap) => {
        const entry = docDataToJournalEntry(docSnap.data());
        if (entry.id) {
          pageEntries.push(entry);
          collected.push(entry);
        }
      });

      lastDocSnap = snapshot.docs[snapshot.docs.length - 1];
      const pageLastIso =
        pageEntries.length > 0
          ? pageEntries[pageEntries.length - 1].updatedAtIso
          : latestCursorIso;

      if (pageLastIso && (!latestCursorIso || pageLastIso > latestCursorIso)) {
        latestCursorIso = pageLastIso;
      }

      if (onPage && pageEntries.length > 0 && latestCursorIso) {
        await onPage(pageEntries, latestCursorIso);
      }

      if (snapshot.docs.length < pageSize) {
        break;
      }
    }

    return { entries: collected, latestCursorIso };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code || '';

    // On first-time sync ONLY (when sinceUpdatedAtIso is null), if the composite index
    // (ownerId ASC, updatedAtIso ASC) is not yet built, perform a one-time ownerId query.
    // Never fall back to full-collection queries during incremental sync.
    if (
      !sinceUpdatedAtIso &&
      (code === 'failed-precondition' || msg.includes('requires an index'))
    ) {
      try {
        const fallbackQuery = query(
          collection(db, 'entries'),
          where('ownerId', '==', uid),
          limit(pageSize)
        );
        const snap = await getDocs(fallbackQuery);
        const pageEntries: JournalEntry[] = [];
        snap.docs.forEach((docSnap) => {
          const entry = docDataToJournalEntry(docSnap.data());
          if (entry.id) {
            pageEntries.push(entry);
          }
        });
        pageEntries.sort((a, b) => a.updatedAtIso.localeCompare(b.updatedAtIso));
        for (const e of pageEntries) {
          collected.push(e);
          if (!latestCursorIso || e.updatedAtIso > latestCursorIso) {
            latestCursorIso = e.updatedAtIso;
          }
        }
        if (onPage && pageEntries.length > 0 && latestCursorIso) {
          await onPage(pageEntries, latestCursorIso);
        }
        return { entries: collected, latestCursorIso };
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.LIST, path);
      }
    }

    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function saveUserSettingsToFirestore(settings: UserSettings): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const path = `user_settings/${user.uid}`;
  const payload = {
    ownerId: user.uid,
    theme: ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : 'light',
    defaultCleanupMode: ['light', 'clean'].includes(settings.defaultCleanupMode)
      ? settings.defaultCleanupMode
      : 'clean',
    audioRetention: ['keep', 'delete_after_approval'].includes(settings.audioRetention)
      ? settings.audioRetention
      : 'keep',
    transcriptionProvider: settings.transcriptionProvider || 'gemini-3.5-transcribe',
    accentColor:
      settings.accentColor &&
      ['terracotta', 'midnight', 'sapphire', 'forest'].includes(settings.accentColor)
        ? settings.accentColor
        : 'terracotta',
    updatedAt: serverTimestamp(),
  };

  try {
    // Direct setDoc eliminates the pre-write getDoc() read while satisfying both
    // allow create and allow update in firestore.rules (since ownerId is unchanged).
    await setDoc(doc(db, 'user_settings', user.uid), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
