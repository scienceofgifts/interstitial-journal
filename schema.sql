-- Cloudflare D1 Schema for Interstitial Journal (schema.sql)
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  raw_transcription TEXT NOT NULL,
  cleaned_transcription TEXT NOT NULL DEFAULT '',
  final_text TEXT NOT NULL,
  cleanup_mode TEXT NOT NULL DEFAULT 'none',
  ambiguity_notes TEXT NOT NULL DEFAULT '',
  audio_id TEXT NOT NULL DEFAULT '',
  audio_mime_type TEXT NOT NULL DEFAULT '',
  audio_duration_sec REAL NOT NULL DEFAULT 0,
  date_key TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_date_key ON journal_entries(date_key DESC, created_at_iso DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);
