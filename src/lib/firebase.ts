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
  onSnapshot,
  serverTimestamp,
  getDocFromServer,
  getDoc,
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

// Validate connection to Firestore on boot per skill requirements
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

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
function sanitizeEntryForFirestore(entry: JournalEntry, uid: string) {
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

export async function deleteEntryFromFirestore(entryId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeId = entryId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
  const path = `entries/${safeId}`;
  try {
    await deleteDoc(doc(db, 'entries', safeId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToFirestoreEntries(
  uid: string,
  onEntries: (entries: JournalEntry[]) => void
): () => void {
  const path = 'entries';
  const q = query(collection(db, 'entries'), where('ownerId', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const items: JournalEntry[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        items.push({
          id: d.id,
          ownerId: d.ownerId,
          rawTranscription: d.rawTranscription || '',
          cleanedTranscription: d.cleanedTranscription || '',
          finalText: d.finalText || '',
          cleanupMode: d.cleanupMode || 'none',
          ambiguityNotes: d.ambiguityNotes || '',
          audioId: d.audioId || '',
          audioMimeType: d.audioMimeType || '',
          audioDurationSec: Number(d.audioDurationSec) || 0,
          dateKey: d.dateKey || '',
          createdAtIso: d.createdAtIso || new Date().toISOString(),
          updatedAtIso: d.updatedAtIso || new Date().toISOString(),
        });
      });
      items.sort(
        (a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
      );
      onEntries(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
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
    accentColor: settings.accentColor && ['terracotta', 'midnight', 'sapphire', 'forest'].includes(settings.accentColor)
      ? settings.accentColor
      : 'terracotta',
    updatedAt: serverTimestamp(),
  };

  try {
    const existingSnap = await getDoc(doc(db, 'user_settings', user.uid));
    if (existingSnap.exists()) {
      await updateDoc(doc(db, 'user_settings', user.uid), {
        theme: payload.theme,
        defaultCleanupMode: payload.defaultCleanupMode,
        audioRetention: payload.audioRetention,
        transcriptionProvider: payload.transcriptionProvider,
        accentColor: payload.accentColor,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(doc(db, 'user_settings', user.uid), payload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
