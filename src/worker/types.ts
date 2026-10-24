export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  all(): Promise<{ results?: any[]; success?: boolean; error?: string }>;
  first(colName?: string): Promise<any>;
  run(): Promise<{ success: boolean; error?: string }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<any[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface R2PutOptions {
  customMetadata?: Record<string, string>;
  httpMetadata?: Record<string, string>;
}

export interface R2GetOptions {
  range?: Headers | { offset?: number; length?: number } | string;
}

export interface R2ObjectBody {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  customMetadata?: Record<string, string>;
  range?: { offset: number; length: number };
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2Bucket {
  put(key: string, value: any, options?: R2PutOptions): Promise<any>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

export interface Env {
  // Secrets and Environment Variables
  GEMINI_API_KEY?: string;
  TRANSCRIPTION_MODEL?: string;
  GEMINI_FLASH_LITE_MODEL?: string;
  APP_URL?: string;

  // Cloudflare D1 Database binding for persistent entries and settings
  DB?: D1Database;

  // Cloudflare R2 Bucket binding for audio object storage
  AUDIO_BUCKET?: R2Bucket;

  // Optional Cloudflare KV binding for lightweight fallback
  KV?: KVNamespace;

  // Static assets binding (Workers + Static Assets)
  ASSETS?: Fetcher;
}

export interface JournalEntryRecord {
  id: string;
  ownerId: string;
  rawTranscription: string;
  cleanedTranscription: string;
  finalText: string;
  cleanupMode: 'none' | 'light' | 'clean';
  ambiguityNotes: string;
  audioId: string;
  audioMimeType: string;
  audioDurationSec: number;
  dateKey: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export type AccentColorPreference = 'terracotta' | 'midnight' | 'sapphire' | 'forest';

export interface UserSettingsRecord {
  theme: 'light' | 'dark' | 'system';
  defaultCleanupMode: 'light' | 'clean';
  audioRetention: 'keep' | 'delete_after_approval';
  transcriptionProvider: string;
  accentColor?: AccentColorPreference;
  updatedAtIso?: string;
}
