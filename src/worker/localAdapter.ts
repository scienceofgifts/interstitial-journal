import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Env,
  JournalEntryRecord,
  UserSettingsRecord,
  D1Database,
  R2Bucket,
  R2PutOptions,
  R2GetOptions,
} from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Ensure local development directories exist
fs.mkdirSync(AUDIO_DIR, { recursive: true });

function readDiskEntries(): JournalEntryRecord[] {
  try {
    if (!fs.existsSync(ENTRIES_FILE)) return [];
    const content = fs.readFileSync(ENTRIES_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Error reading local entries.json:', err);
    return [];
  }
}

function writeDiskEntries(entries: JournalEntryRecord[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${ENTRIES_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf-8');
  fs.renameSync(temp, ENTRIES_FILE);
}

function readDiskSettings(): UserSettingsRecord | null {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeDiskSettings(settings: UserSettingsRecord): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Creates a local D1Database adapter that persists to data/entries.json and data/settings.json
 */
export function createLocalD1Database(): D1Database {
  return {
    prepare(sql: string) {
      let boundValues: any[] = [];
      const stmt: any = {
        bind(...values: any[]) {
          boundValues = values;
          return stmt;
        },
        async all() {
          if (sql.includes('FROM journal_entries')) {
            const entries = readDiskEntries();
            entries.sort(
              (a, b) => new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
            );
            return {
              results: entries.map((e) => ({
                id: e.id,
                owner_id: e.ownerId,
                raw_transcription: e.rawTranscription,
                cleaned_transcription: e.cleanedTranscription,
                final_text: e.finalText,
                cleanup_mode: e.cleanupMode,
                ambiguity_notes: e.ambiguityNotes,
                audio_id: e.audioId,
                audio_mime_type: e.audioMimeType,
                audio_duration_sec: e.audioDurationSec,
                date_key: e.dateKey,
                created_at_iso: e.createdAtIso,
                updated_at_iso: e.updatedAtIso,
              })),
            };
          }
          return { results: [] };
        },
        async first(colName?: string) {
          if (sql.includes('FROM user_settings')) {
            const settings = readDiskSettings();
            if (settings) {
              return colName ? settings[colName as keyof UserSettingsRecord] : { data: JSON.stringify(settings) };
            }
            return null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO journal_entries')) {
            const [
              id,
              ownerId,
              rawTranscription,
              cleanedTranscription,
              finalText,
              cleanupMode,
              ambiguityNotes,
              audioId,
              audioMimeType,
              audioDurationSec,
              dateKey,
              createdAtIso,
              updatedAtIso,
            ] = boundValues;

            const entry: JournalEntryRecord = {
              id: String(id),
              ownerId: String(ownerId || 'local'),
              rawTranscription: String(rawTranscription || ''),
              cleanedTranscription: String(cleanedTranscription || ''),
              finalText: String(finalText || ''),
              cleanupMode: cleanupMode || 'none',
              ambiguityNotes: String(ambiguityNotes || ''),
              audioId: String(audioId || ''),
              audioMimeType: String(audioMimeType || ''),
              audioDurationSec: Number(audioDurationSec) || 0,
              dateKey: String(dateKey),
              createdAtIso: String(createdAtIso),
              updatedAtIso: String(updatedAtIso),
            };

            const entries = readDiskEntries();
            const existingIdx = entries.findIndex((e) => e.id === entry.id);
            if (existingIdx >= 0) {
              entry.createdAtIso = entries[existingIdx].createdAtIso;
              entries[existingIdx] = entry;
            } else {
              entries.unshift(entry);
            }
            writeDiskEntries(entries);
            return { success: true };
          }

          if (sql.includes('DELETE FROM journal_entries')) {
            const [entryId] = boundValues;
            const entries = readDiskEntries().filter((e) => e.id !== entryId);
            writeDiskEntries(entries);
            return { success: true };
          }

          if (sql.includes('UPDATE journal_entries SET audio_id')) {
            const [audioId] = boundValues;
            const entries = readDiskEntries().map((e) =>
              e.audioId === audioId ? { ...e, audioId: '', audioMimeType: '' } : e
            );
            writeDiskEntries(entries);
            return { success: true };
          }

          if (sql.includes('INSERT INTO user_settings')) {
            const [, dataJson] = boundValues;
            if (dataJson) {
              writeDiskSettings(JSON.parse(dataJson));
            }
            return { success: true };
          }

          return { success: true };
        },
      };
      return stmt;
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    async batch() {
      return [];
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

/**
 * Creates a local R2Bucket adapter that persists audio files to data/audio/
 */
export function createLocalR2Bucket(): R2Bucket {
  return {
    async put(key: string, value: any, options?: R2PutOptions) {
      const binPath = path.join(AUDIO_DIR, `${key}.bin`);
      const metaPath = path.join(AUDIO_DIR, `${key}.meta.json`);

      let buffer: Buffer;
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        buffer = Buffer.from(value);
      } else if (value instanceof ArrayBuffer) {
        buffer = Buffer.from(value);
      } else {
        buffer = Buffer.from(value);
      }

      fs.writeFileSync(binPath, buffer);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          audioId: key,
          mimeType: options?.customMetadata?.mimeType || 'audio/webm',
          durationSec: Number(options?.customMetadata?.durationSec) || 0,
          sizeBytes: buffer.length,
          createdAtIso: options?.customMetadata?.createdAtIso || new Date().toISOString(),
        }),
        'utf-8'
      );

      return {
        key,
        size: buffer.length,
        etag: `"${buffer.length}-${Date.now()}"`,
        httpEtag: `"${buffer.length}-${Date.now()}"`,
        customMetadata: options?.customMetadata,
      } as any;
    },

    async get(key: string, options?: R2GetOptions) {
      const binPath = path.join(AUDIO_DIR, `${key}.bin`);
      const metaPath = path.join(AUDIO_DIR, `${key}.meta.json`);

      if (!fs.existsSync(binPath)) {
        return null;
      }

      let customMetadata: Record<string, string> = { mimeType: 'audio/webm' };
      if (fs.existsSync(metaPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (parsed.mimeType) customMetadata.mimeType = parsed.mimeType;
          if (parsed.durationSec) customMetadata.durationSec = String(parsed.durationSec);
        } catch {
          // ignore
        }
      }

      const totalSize = fs.statSync(binPath).size;
      const fileBuffer = fs.readFileSync(binPath);

      let bodyData = fileBuffer;
      let rangeResult: any = undefined;

      const rangeHeader = (options?.range as any)?.get?.('range') || (options?.range as any);
      if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        bodyData = fileBuffer.subarray(start, end + 1);
        rangeResult = { offset: start, length: bodyData.length };
      }

      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bodyData));
          controller.close();
        },
      });

      return {
        key,
        size: bodyData.length,
        httpEtag: `"${totalSize}"`,
        customMetadata,
        range: rangeResult,
        body: readableStream,
        async arrayBuffer() {
          return fileBuffer.buffer;
        },
        writeHttpMetadata(headers: Headers) {
          headers.set('Content-Type', customMetadata.mimeType || 'audio/webm');
          headers.set('Content-Length', String(bodyData.length));
        },
      } as any;
    },

    async delete(key: string) {
      const binPath = path.join(AUDIO_DIR, `${key}.bin`);
      const metaPath = path.join(AUDIO_DIR, `${key}.meta.json`);
      if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    },
  } as unknown as R2Bucket;
}

export function createLocalEnv(): Env {
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    TRANSCRIPTION_MODEL: process.env.TRANSCRIPTION_MODEL,
    GEMINI_FLASH_LITE_MODEL: process.env.GEMINI_FLASH_LITE_MODEL || 'gemini-3.5-flash-lite',
    APP_URL: process.env.APP_URL,
    DB: createLocalD1Database(),
    AUDIO_BUCKET: createLocalR2Bucket(),
  };
}
