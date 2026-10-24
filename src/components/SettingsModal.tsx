import React, { useState } from 'react';
import {
  X,
  Sun,
  Moon,
  Monitor,
  Download,
  ShieldCheck,
  Database,
  LogIn,
  LogOut,
  Copy,
  Check,
} from 'lucide-react';
import {
  AccentColorPreference,
  AudioRetentionPreference,
  JournalEntry,
  ThemePreference,
  TranscriptionProviderId,
  UserSettings,
} from '../types/journal';
import { User } from '../lib/firebase';
import { PWAInstallButton } from './PWAInstallButton';

const ACCENT_OPTIONS: { id: AccentColorPreference; name: string; swatchVar: string }[] = [
  { id: 'terracotta', name: 'Terracotta', swatchVar: '--swatch-terracotta' },
  { id: 'midnight', name: 'Midnight', swatchVar: '--swatch-midnight' },
  { id: 'sapphire', name: 'Sapphire', swatchVar: '--swatch-sapphire' },
  { id: 'forest', name: 'Forest', swatchVar: '--swatch-forest' },
];

interface SettingsModalProps {
  settings: UserSettings;
  entries: JournalEntry[];
  user: User | null;
  onUpdateSettings: (next: UserSettings) => void;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onClose: () => void;
}

const CLOUDFLARE_D1_SCHEMA = `-- Cloudflare D1 Schema for Interstitial Journal (schema.sql)
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
`;

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  entries,
  user,
  onUpdateSettings,
  onSignIn,
  onSignOut,
  onClose,
}) => {
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [showCloudflareGuide, setShowCloudflareGuide] = useState(false);

  const handleThemeChange = (theme: ThemePreference) => {
    onUpdateSettings({ ...settings, theme });
  };

  const handleAccentChange = (accentColor: AccentColorPreference) => {
    onUpdateSettings({ ...settings, accentColor });
  };

  const handleCleanupPrefChange = (defaultCleanupMode: 'light' | 'clean') => {
    onUpdateSettings({ ...settings, defaultCleanupMode });
  };

  const handleRetentionChange = (audioRetention: AudioRetentionPreference) => {
    onUpdateSettings({ ...settings, audioRetention });
  };

  const handleProviderChange = (transcriptionProvider: TranscriptionProviderId) => {
    onUpdateSettings({ ...settings, transcriptionProvider });
  };

  const exportAsJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'Interstitial',
      entryCount: entries.length,
      entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interstitial-journal-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAsMarkdown = () => {
    const lines: string[] = [
      '# Interstitial — Personal Voice Journal',
      `Exported on ${new Date().toLocaleDateString()} (${entries.length} entries)`,
      '',
    ];

    const grouped = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.dateKey) || [];
      list.push(entry);
      grouped.set(entry.dateKey, list);
    }

    for (const [dateKey, dayEntries] of grouped.entries()) {
      lines.push(`## ${dateKey}`);
      lines.push('');
      for (const e of dayEntries) {
        const timeStr = new Date(e.createdAtIso).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        lines.push(`### ${timeStr}`);
        lines.push(e.finalText);
        if (e.rawTranscription && e.rawTranscription !== e.finalText) {
          lines.push('');
          lines.push(`> *Original verbatim transcript:* ${e.rawTranscription}`);
        }
        lines.push('');
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interstitial-journal-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyD1Schema = () => {
    navigator.clipboard.writeText(CLOUDFLARE_D1_SCHEMA);
    setCopiedSchema(true);
    setTimeout(() => setCopiedSchema(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-6 md:p-8 shadow-xl my-auto max-h-[90vh] overflow-y-auto space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-4">
          <div>
            <h2 className="font-serif-editorial text-2xl text-[var(--text-primary)]">
              Journal Settings
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Appearance, transcription preferences, data export, and storage architecture.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] min-h-[40px] min-w-[40px] flex items-center justify-center"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 1. Appearance */}
        <div className="space-y-4">
          <div className="space-y-2.5">
            <label className="block text-xs font-semibold text-[var(--text-primary)]">
              Appearance
            </label>
            <div className="grid grid-cols-3 gap-2 rounded-xl bg-[var(--bg-surface)] p-1.5 border border-[var(--border-hairline)]">
              <button
                type="button"
                onClick={() => handleThemeChange('light')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-medium transition-colors min-h-[40px] cursor-pointer ${
                  settings.theme === 'light'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>Light</span>
              </button>
              <button
                type="button"
                onClick={() => handleThemeChange('dark')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-medium transition-colors min-h-[40px] cursor-pointer ${
                  settings.theme === 'dark'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>Dark</span>
              </button>
              <button
                type="button"
                onClick={() => handleThemeChange('system')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-medium transition-colors min-h-[40px] cursor-pointer ${
                  settings.theme === 'system'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
                <span>System</span>
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            <label className="block text-xs font-semibold text-[var(--text-primary)]">
              Accent Colour
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ACCENT_OPTIONS.map((opt) => {
                const isSelected = (settings.accentColor || 'terracotta') === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleAccentChange(opt.id)}
                    className={`flex items-center gap-2 rounded-xl border p-2.5 text-xs font-medium transition-colors min-h-[44px] cursor-pointer ${
                      isSelected
                        ? 'border-[var(--accent-terracotta)] bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs ring-1 ring-[var(--accent-terracotta)]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]'
                    }`}
                    aria-pressed={isSelected}
                    aria-label={`Accent colour: ${opt.name}`}
                  >
                    <span
                      className="w-4 h-4 rounded-full shrink-0 border border-black/15 dark:border-white/20 shadow-2xs"
                      style={{ backgroundColor: `var(${opt.swatchVar})` }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{opt.name}</span>
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 ml-auto text-[var(--accent-terracotta)] shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 2. Default Transcription Cleanup Preference */}
        <div className="space-y-2.5">
          <label className="block text-xs font-semibold text-[var(--text-primary)]">
            Default Transcription Cleanup
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => handleCleanupPrefChange('light')}
              className={`text-left rounded-xl border p-3.5 transition-colors ${
                settings.defaultCleanupMode === 'light'
                  ? 'border-[var(--accent-sage)] bg-[var(--accent-sage-soft)]/50'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'
              }`}
            >
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Light cleanup
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
                Corrects punctuation and obvious recognition errors while preserving your exact natural wording.
              </p>
            </button>

            <button
              type="button"
              onClick={() => handleCleanupPrefChange('clean')}
              className={`text-left rounded-xl border p-3.5 transition-colors ${
                settings.defaultCleanupMode === 'clean'
                  ? 'border-[var(--accent-sage)] bg-[var(--accent-sage-soft)]/50'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'
              }`}
            >
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Clean and readable
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
                Removes fillers (&ldquo;um&rdquo;, &ldquo;uh&rdquo;) and false starts to produce a smooth, faithful transcript.
              </p>
            </button>
          </div>
        </div>

        {/* 3. Original Audio Retention Preference */}
        <div className="space-y-2.5">
          <label className="block text-xs font-semibold text-[var(--text-primary)]">
            Original Audio Retention
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => handleRetentionChange('keep')}
              className={`text-left rounded-xl border p-3.5 transition-colors ${
                settings.audioRetention === 'keep'
                  ? 'border-[var(--accent-sage)] bg-[var(--accent-sage-soft)]/50'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'
              }`}
            >
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Retain original audio
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
                Keep voice recordings in object storage so you can replay them from the timeline.
              </p>
            </button>

            <button
              type="button"
              onClick={() => handleRetentionChange('delete_after_approval')}
              className={`text-left rounded-xl border p-3.5 transition-colors ${
                settings.audioRetention === 'delete_after_approval'
                  ? 'border-[var(--accent-sage)] bg-[var(--accent-sage-soft)]/50'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'
              }`}
            >
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Delete after approval
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
                Automatically delete the raw audio file once you approve and save the transcription.
              </p>
            </button>
          </div>
        </div>

        {/* 4. Speech-to-Text Provider Configuration */}
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-[var(--text-primary)]">
            Speech-to-Text Provider
          </label>
          <select
            value={settings.transcriptionProvider}
            onChange={(e) =>
              handleProviderChange(e.target.value as TranscriptionProviderId)
            }
            className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent-sage)] focus:outline-none min-h-[42px]"
          >
            <option value="gemini-3.5-transcribe">
              Gemini 3.5 Transcribe (Dedicated Speech Recognition Model)
            </option>
            <option value="browser-speech">
              Gemini 3.5 Transcribe + Browser Speech Hybrid
            </option>
          </select>
        </div>

        {/* 5. Private Cloud Account Synchronization & PWA Install */}
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Private Account & Multi-Device Sync
              </div>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {user
                  ? `Signed in as ${user.email} · Synced with private Firestore database`
                  : 'Sign in with Google to synchronize your private journal across devices.'}
              </p>
            </div>
            {user ? (
              <button
                type="button"
                onClick={onSignOut}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[38px]"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSignIn}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-sage)] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-sage-hover)] transition-colors min-h-[38px]"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In with Google</span>
              </button>
            )}
          </div>
          <div className="pt-2 border-t border-[var(--border-hairline)] flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">
              Installable Progressive Web App
            </span>
            <PWAInstallButton />
          </div>
        </div>

        {/* 6. Journal Export */}
        <div className="space-y-2.5">
          <label className="block text-xs font-semibold text-[var(--text-primary)]">
            Export Journal Data ({entries.length}{' '}
            {entries.length === 1 ? 'entry' : 'entries'})
          </label>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={exportAsMarkdown}
              disabled={entries.length === 0}
              className="flex items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-2.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40 min-h-[42px]"
            >
              <Download className="w-3.5 h-3.5 text-[var(--accent-sage)]" />
              <span>Export as Markdown (.md)</span>
            </button>
            <button
              type="button"
              onClick={exportAsJson}
              disabled={entries.length === 0}
              className="flex items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-2.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40 min-h-[42px]"
            >
              <Download className="w-3.5 h-3.5 text-[var(--accent-terracotta)]" />
              <span>Export Full Archive (.json)</span>
            </button>
          </div>
        </div>

        {/* 7. Privacy, Storage & Cloudflare D1 Architecture */}
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed">
          <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-sage)]" />
            <span>Privacy, Storage & Processing Architecture</span>
          </div>
          <ul className="space-y-1.5 list-disc list-inside">
            <li>
              <strong>Server-Side Secrets:</strong> API credentials remain strictly on the server and are never exposed in client bundles.
            </li>
            <li>
              <strong>Explicit AI Invocation:</strong> Audio and text are processed by <code>gemini-3.5-flash-lite</code> only when transcribing a recording or when you click <em>Improve Transcription</em>.
            </li>
            <li>
              <strong>Persistent Storage & Audio Lifecycle:</strong> Entries persist in your private Firestore database and server disk store (<code>/data/entries.json</code>). Retained audio blobs are stored separately in object storage (<code>/api/audio/:id</code>) and are deleted immediately when you delete an entry or its audio.
            </li>
          </ul>

          <div className="pt-2 border-t border-[var(--border-hairline)]">
            <button
              type="button"
              onClick={() => setShowCloudflareGuide(!showCloudflareGuide)}
              className="inline-flex items-center gap-1.5 font-medium text-[var(--accent-sage)] hover:underline"
            >
              <Database className="w-3.5 h-3.5" />
              <span>
                {showCloudflareGuide
                  ? 'Hide Cloudflare Pages + D1 Deployment Schema'
                  : 'View Cloudflare Pages + D1 Deployment Schema'}
              </span>
            </button>

            {showCloudflareGuide && (
              <div className="mt-3 space-y-2">
                <p>
                  When deploying to Cloudflare Pages with Functions, bind a D1 database (<code>DB</code>), an R2 bucket for audio objects (<code>AUDIO_BUCKET</code>), and configure <code>GEMINI_API_KEY</code> via <code>wrangler pages secret put GEMINI_API_KEY</code>:
                </p>
                <div className="relative rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-hairline)] p-3 font-mono-tabular text-[11px] overflow-x-auto">
                  <button
                    type="button"
                    onClick={copyD1Schema}
                    className="absolute top-2 right-2 inline-flex items-center gap-1 rounded bg-[var(--bg-surface)] px-2 py-1 text-[10px] text-[var(--text-primary)] border border-[var(--border-strong)]"
                  >
                    {copiedSchema ? (
                      <>
                        <Check className="w-3 h-3 text-[var(--state-success)]" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy SQL</span>
                      </>
                    )}
                  </button>
                  <pre className="whitespace-pre">{CLOUDFLARE_D1_SCHEMA}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
