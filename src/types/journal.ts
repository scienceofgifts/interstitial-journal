export type CleanupMode = 'none' | 'light' | 'clean';
export type ThemePreference = 'light' | 'dark' | 'system';
export type AudioRetentionPreference = 'keep' | 'delete_after_approval';
export type TranscriptionProviderId = 'gemini-3.5-transcribe' | 'browser-speech';
export type AccentColorPreference = 'terracotta' | 'midnight' | 'sapphire' | 'forest';

export type EntrySyncStatus =
  | 'synced'
  | 'pending_upsert'
  | 'pending_delete'
  | 'deleted_synced';

export type CloudSyncState = 'idle' | 'syncing' | 'synced' | 'pending' | 'error';

export interface SyncStateSummary {
  state: CloudSyncState;
  pendingCount: number;
  lastSyncedAtIso: string | null;
  errorMessage: string | null;
}

export interface JournalEntry {
  id: string;
  ownerId: string;
  rawTranscription: string;
  cleanedTranscription: string;
  finalText: string;
  cleanupMode: CleanupMode;
  ambiguityNotes: string;
  audioId: string;
  audioMimeType: string;
  audioDurationSec: number;
  dateKey: string; // YYYY-MM-DD in user's local timezone
  createdAtIso: string;
  updatedAtIso: string;
  // Local-only synchronization metadata (stripped before Firestore writes)
  syncStatus?: EntrySyncStatus;
  cloudSynced?: boolean;
  lastSyncedUpdatedAtIso?: string;
  deletedAtIso?: string;
}

export interface UserSettings {
  theme: ThemePreference;
  defaultCleanupMode: 'light' | 'clean';
  audioRetention: AudioRetentionPreference;
  transcriptionProvider: TranscriptionProviderId;
  accentColor?: AccentColorPreference;
}

export function areSettingsEqual(a: UserSettings, b: UserSettings): boolean {
  return (
    a.theme === b.theme &&
    a.defaultCleanupMode === b.defaultCleanupMode &&
    a.audioRetention === b.audioRetention &&
    a.transcriptionProvider === b.transcriptionProvider &&
    (a.accentColor || 'terracotta') === (b.accentColor || 'terracotta')
  );
}

export interface ActiveDraft {
  id: string;
  audioId: string;
  audioBlob?: Blob;
  audioMimeType: string;
  audioDurationSec: number;
  rawTranscription: string;
  cleanedTranscription: string;
  finalText: string;
  cleanupMode: CleanupMode;
  ambiguityNotes: string;
  stage: 'recorded' | 'transcribing' | 'transcribed' | 'cleaning' | 'review';
  createdAtIso: string;
  errorMessage?: string;
}

export function getLocalDateKey(isoString?: string): string {
  const date = isoString ? new Date(isoString) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatEditorialDateHeading(dateKey: string): {
  primary: string;
  secondary: string;
  isToday: boolean;
} {
  const todayKey = getLocalDateKey();
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayKey = getLocalDateKey(yesterdayDate.toISOString());

  const [y, m, d] = dateKey.split('-').map(Number);
  const dateObj = new Date(y, (m || 1) - 1, d || 1);

  const fullFormatted = dateObj.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  if (dateKey === todayKey) {
    return {
      primary: 'Today',
      secondary: fullFormatted,
      isToday: true,
    };
  }
  if (dateKey === yesterdayKey) {
    return {
      primary: 'Yesterday',
      secondary: fullFormatted,
      isToday: false,
    };
  }

  return {
    primary: dateObj.toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
    secondary: dateObj.toLocaleDateString(undefined, { weekday: 'long' }),
    isToday: false,
  };
}

export function formatTimeOfDay(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
