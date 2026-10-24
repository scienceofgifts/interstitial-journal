/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  Search,
  Calendar,
  Settings,
  BookOpen,
  X,
  ChevronRight,
  Sun,
  Moon,
  Volume2,
  Edit3,
  Trash2,
  Download,
} from 'lucide-react';
import {
  AccentColorPreference,
  formatDuration,
  formatEditorialDateHeading,
  formatTimeOfDay,
  getLocalDateKey,
  JournalEntry,
  UserSettings,
} from './types/journal';
import {
  auth,
  createEntryInFirestore,
  deleteEntryFromFirestore,
  onAuthStateChanged,
  saveUserSettingsToFirestore,
  signInWithGoogle,
  signOutUser,
  subscribeToFirestoreEntries,
  updateEntryInFirestore,
  User,
} from './lib/firebase';
import { cacheLocalAudioBlob, deleteCachedLocalAudioBlob } from './lib/draftStorage';
import { VoiceRecorderStudio } from './components/VoiceRecorderStudio';
import { AudioPlayer } from './components/AudioPlayer';
import { EntryDetailModal } from './components/EntryDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';

const DAYS_PER_PAGE = 7;

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, idx) =>
    part.toLowerCase() === query.trim().toLowerCase() ? (
      <mark
        key={idx}
        className="bg-[var(--accent-terracotta-soft)] text-[var(--accent-terracotta)] px-1 rounded-xs font-medium"
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export default function App() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isLoadingEntries, setIsLoadingEntries] = useState<boolean>(true);
  const [user, setUser] = useState<User | null>(null);

  const [settings, setSettings] = useState<UserSettings>(() => {
    let savedAccent: AccentColorPreference = 'terracotta';
    try {
      const stored = localStorage.getItem('interstitial_accent') as AccentColorPreference | null;
      if (stored && ['terracotta', 'midnight', 'sapphire', 'forest'].includes(stored)) {
        savedAccent = stored;
      }
    } catch {}
    return {
      theme: 'light',
      defaultCleanupMode: 'clean',
      audioRetention: 'keep',
      transcriptionProvider: 'gemini-3.5-transcribe',
      accentColor: savedAccent,
    };
  });

  // Navigation & filtering state
  const [activeView, setActiveView] = useState<'journal' | 'search' | 'archive'>('journal');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedDateFilter, setSelectedDateFilter] = useState<string>(''); // YYYY-MM-DD or ''
  const [visibleDayCount, setVisibleDayCount] = useState<number>(DAYS_PER_PAGE);

  // Modals
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const studioContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Apply Light / Dark / System theme to document root
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = (mode: 'light' | 'dark') => {
      if (mode === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    };

    if (settings.theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(media.matches ? 'dark' : 'light');
      const listener = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    } else {
      applyTheme(settings.theme);
    }
  }, [settings.theme]);

  // 1b. Apply Accent Colour preference to document root
  useEffect(() => {
    const accent = settings.accentColor || 'terracotta';
    document.documentElement.setAttribute('data-accent', accent);
    try {
      localStorage.setItem('interstitial_accent', accent);
    } catch {}
  }, [settings.accentColor]);

  // 2. Load persistent server entries & settings on initial mount
  useEffect(() => {
    async function fetchInitialData() {
      setIsLoadingEntries(true);
      try {
        const [entriesRes, settingsRes] = await Promise.all([
          fetch('/api/entries'),
          fetch('/api/settings'),
        ]);
        if (entriesRes.ok) {
          const data = await entriesRes.json();
          if (Array.isArray(data.entries)) {
            setEntries(data.entries);
          }
        }
        if (settingsRes.ok) {
          const sData = await settingsRes.json();
          if (sData.settings) {
            setSettings((prev) => ({
              ...prev,
              ...sData.settings,
              accentColor: sData.settings.accentColor || prev.accentColor || 'terracotta',
            }));
          }
        }
      } catch (err) {
        console.warn('Offline or error loading server entries:', err);
      } finally {
        setIsLoadingEntries(false);
      }
    }
    fetchInitialData();
  }, []);

  // 3. Firebase Auth & Real-Time Firestore Subscription
  useEffect(() => {
    let unsubFirestore: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (unsubFirestore) {
        unsubFirestore();
        unsubFirestore = null;
      }
      if (currentUser && currentUser.emailVerified) {
        unsubFirestore = subscribeToFirestoreEntries(currentUser.uid, (cloudEntries) => {
          setEntries((prevServerEntries) => {
            const byId = new Map<string, JournalEntry>();
            for (const item of prevServerEntries) {
              byId.set(item.id, item);
            }
            for (const cloudItem of cloudEntries) {
              byId.set(cloudItem.id, cloudItem);
            }
            const merged = Array.from(byId.values());
            merged.sort(
              (a, b) =>
                new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()
            );
            return merged;
          });
        });
      }
    });

    return () => {
      unsubAuth();
      if (unsubFirestore) unsubFirestore();
    };
  }, []);

  // Save a newly recorded & reviewed journal entry
  const handleSaveNewEntry = async (newEntry: JournalEntry, audioBlob?: Blob) => {
    if (audioBlob && newEntry.audioId) {
      void cacheLocalAudioBlob(newEntry.audioId, audioBlob, newEntry.audioMimeType);
    }

    // 1. Save to persistent backend API — do not report saved until backend confirms
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newEntry),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to save entry to persistent server storage.');
    }

    const { entry: savedServerEntry } = await res.json();

    setEntries((prev) => {
      const filtered = prev.filter((e) => e.id !== savedServerEntry.id);
      return [savedServerEntry, ...filtered];
    });

    // 2. If authenticated with Firebase, also persist to Firestore without blocking UI state completion
    if (user && user.emailVerified) {
      void createEntryInFirestore({ ...savedServerEntry, ownerId: user.uid }).catch(
        (err) => {
          console.warn('Firestore sync warning:', err);
        }
      );
    }
  };

  // Update an edited entry (preserving createdAtIso, updating updatedAtIso)
  const handleUpdateEntry = async (updatedEntry: JournalEntry) => {
    const res = await fetch(`/api/entries/${encodeURIComponent(updatedEntry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedEntry),
    });

    if (!res.ok) {
      throw new Error('Failed to save updated entry.');
    }

    const { entry: saved } = await res.json();

    setEntries((prev) => prev.map((e) => (e.id === saved.id ? saved : e)));

    if (user && user.emailVerified) {
      void updateEntryInFirestore({ ...saved, ownerId: user.uid }).catch((err) => {
        console.warn('Firestore update warning:', err);
      });
    }
  };

  // Delete an entry and its associated retained audio
  const handleDeleteEntry = async (entryId: string) => {
    const target = entries.find((e) => e.id === entryId);
    if (target?.audioId) {
      void deleteCachedLocalAudioBlob(target.audioId);
    }

    const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error('Failed to delete entry from server.');
    }

    setEntries((prev) => prev.filter((e) => e.id !== entryId));

    if (user && user.emailVerified) {
      void deleteEntryFromFirestore(entryId).catch((err) => {
        console.warn('Firestore delete warning:', err);
      });
    }
  };

  // Delete only the retained audio of an entry while preserving the text entry
  const handleDeleteEntryAudioOnly = async (entry: JournalEntry) => {
    if (!entry.audioId) return;
    const oldAudioId = entry.audioId;

    await deleteCachedLocalAudioBlob(oldAudioId);
    await fetch(`/api/audio/${encodeURIComponent(oldAudioId)}`, {
      method: 'DELETE',
    });

    const updated: JournalEntry = {
      ...entry,
      audioId: '',
      audioMimeType: '',
      audioDurationSec: 0,
      updatedAtIso: new Date().toISOString(),
    };

    await handleUpdateEntry(updated);
    if (selectedEntry?.id === entry.id) {
      setSelectedEntry(updated);
    }
  };

  const handleUpdateSettings = async (next: UserSettings) => {
    setSettings(next);
    try {
      localStorage.setItem('interstitial_accent', next.accentColor || 'terracotta');
    } catch {}
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {});

    if (user && user.emailVerified) {
      await saveUserSettingsToFirestore(next).catch(() => {});
    }
  };

  // Filtered entries based on search query and date filter
  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (selectedDateFilter && entry.dateKey !== selectedDateFilter) {
        return false;
      }
      if (!q) return true;
      return (
        entry.finalText.toLowerCase().includes(q) ||
        entry.rawTranscription.toLowerCase().includes(q) ||
        entry.cleanedTranscription.toLowerCase().includes(q)
      );
    });
  }, [entries, searchQuery, selectedDateFilter]);

  // Group filtered entries chronologically by day (dateKey descending)
  const groupedByDay = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of filteredEntries) {
      const key = entry.dateKey || getLocalDateKey(entry.createdAtIso);
      const list = map.get(key) || [];
      list.push(entry);
      map.set(key, list);
    }
    const sortedKeys = Array.from(map.keys()).sort((a, b) => b.localeCompare(a));
    return sortedKeys.map((dateKey) => ({
      dateKey,
      entries: map.get(dateKey) || [],
    }));
  }, [filteredEntries]);

  // Distinct dates that have entries for the Archive / Calendar rail
  const allDatesWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      counts.set(e.dateKey, (counts.get(e.dateKey) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateKey, count]) => ({ dateKey, count }));
  }, [entries]);

  const visibleDays = groupedByDay.slice(0, visibleDayCount);
  const hasMoreDays = groupedByDay.length > visibleDayCount;

  const totalSpokenSec = useMemo(
    () => entries.reduce((acc, e) => acc + (Number(e.audioDurationSec) || 0), 0),
    [entries]
  );

  const focusRecorderStudio = () => {
    setActiveView('journal');
    studioContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)] pb-20 md:pb-12">
      {/* TOP BAR CONTRACT: 3 Zones separated by gap-8 */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-hairline)] bg-[var(--bg-canvas)]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 h-14">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('journal');
              setSelectedDateFilter('');
              setSearchQuery('');
            }}
            className="font-serif-editorial text-xl font-semibold tracking-tight text-[var(--text-primary)] whitespace-nowrap shrink-0"
          >
            Interstitial
          </a>

          {/* Zone 2: 4 concise single-line text navigation links */}
          <nav className="hidden md:flex items-center gap-7 text-xs font-medium text-[var(--text-secondary)]">
            <button
              type="button"
              onClick={() => {
                setActiveView('journal');
                setSelectedDateFilter('');
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeView === 'journal' && !selectedDateFilter
                  ? 'text-[var(--text-primary)] underline underline-offset-4 decoration-[var(--accent-terracotta)]'
                  : 'hover:text-[var(--text-primary)]'
              }`}
            >
              Timeline
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveView('search');
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeView === 'search'
                  ? 'text-[var(--text-primary)] underline underline-offset-4 decoration-[var(--accent-terracotta)]'
                  : 'hover:text-[var(--text-primary)]'
              }`}
            >
              Search
            </button>
            <button
              type="button"
              onClick={() => setActiveView('archive')}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeView === 'archive'
                  ? 'text-[var(--text-primary)] underline underline-offset-4 decoration-[var(--accent-terracotta)]'
                  : 'hover:text-[var(--text-primary)]'
              }`}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="py-1 hover:text-[var(--text-primary)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Settings
            </button>
          </nav>

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={focusRecorderStudio}
              className="flex items-center gap-2 rounded-lg bg-[var(--accent-terracotta)] hover:bg-[var(--accent-terracotta-hover)] px-3.5 py-2 text-xs font-semibold text-[var(--accent-contrast,#ffffff)] transition-colors whitespace-nowrap shrink-0 min-h-[38px] cursor-pointer"
            >
              <Mic className="w-3.5 h-3.5" />
              <span>Record Thought</span>
            </button>
          </div>
        </div>
      </header>

      {/* MAIN EDITORIAL WORKSPACE */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 pt-6 md:pt-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          {/* LEFT / MAIN COLUMN (8 cols on desktop) */}
          <div className="lg:col-span-8 space-y-10">
            {/* Voice Capture Studio — Always immediately accessible */}
            <div ref={studioContainerRef}>
              <VoiceRecorderStudio
                defaultCleanupMode={settings.defaultCleanupMode}
                audioRetention={settings.audioRetention}
                ownerId={user?.uid || 'local'}
                onSaveEntry={handleSaveNewEntry}
              />
            </div>

            {/* Search & Active Filter Bar */}
            {(activeView === 'search' || searchQuery || selectedDateFilter) && (
              <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 space-y-3">
                <div className="relative flex items-center">
                  <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3.5 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search across all journal entries and raw transcripts..."
                    className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] pl-10 pr-9 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-sage)] focus:outline-none min-h-[44px]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      aria-label="Clear search query"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>Filter by date:</span>
                    <input
                      type="date"
                      value={selectedDateFilter}
                      onChange={(e) => setSelectedDateFilter(e.target.value)}
                      className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2.5 py-1 text-xs text-[var(--text-primary)] font-mono-tabular"
                    />
                    {selectedDateFilter && (
                      <button
                        type="button"
                        onClick={() => setSelectedDateFilter('')}
                        className="text-[var(--accent-terracotta)] hover:underline font-medium"
                      >
                        Clear date ({selectedDateFilter})
                      </button>
                    )}
                  </div>
                  <span className="font-mono-tabular">
                    {filteredEntries.length}{' '}
                    {filteredEntries.length === 1 ? 'matching entry' : 'matching entries'}
                  </span>
                </div>
              </div>
            )}

            {/* Mobile Archive Calendar Drawer when 'archive' tab is active on small screens */}
            {activeView === 'archive' && (
              <div className="lg:hidden rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-serif-editorial text-lg text-[var(--text-primary)]">
                    Browse by Day
                  </h3>
                  {selectedDateFilter && (
                    <button
                      type="button"
                      onClick={() => setSelectedDateFilter('')}
                      className="text-xs text-[var(--accent-terracotta)] hover:underline"
                    >
                      Show all days
                    </button>
                  )}
                </div>
                {allDatesWithCounts.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    No recorded days yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {allDatesWithCounts.map(({ dateKey, count }) => {
                      const heading = formatEditorialDateHeading(dateKey);
                      const isSelected = selectedDateFilter === dateKey;
                      return (
                        <button
                          key={dateKey}
                          type="button"
                          onClick={() => {
                            setSelectedDateFilter(isSelected ? '' : dateKey);
                            setActiveView('journal');
                          }}
                          className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-left text-xs transition-colors min-h-[44px] ${
                            isSelected
                              ? 'border-[var(--accent-sage)] bg-[var(--accent-sage-soft)] text-[var(--text-primary)] font-semibold'
                              : 'border-[var(--border-hairline)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          <span>{heading.primary}</span>
                          <span className="font-mono-tabular text-[var(--text-muted)]">
                            {count} {count === 1 ? 'note' : 'notes'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* CHRONOLOGICAL INTERSTITIAL TIMELINE */}
            <section aria-label="Journal Timeline" className="space-y-10">
              {isLoadingEntries ? (
                <div className="py-12 text-center text-sm text-[var(--text-muted)]">
                  Loading your journal entries...
                </div>
              ) : groupedByDay.length === 0 ? (
                <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]/60 px-6 py-14 text-center space-y-3">
                  <BookOpen className="w-7 h-7 text-[var(--text-muted)] mx-auto stroke-[1.5]" />
                  <h3 className="font-serif-editorial text-xl text-[var(--text-primary)]">
                    {searchQuery || selectedDateFilter
                      ? 'No entries match your filter'
                      : 'Your journal is ready for your first thought'}
                  </h3>
                  <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
                    {searchQuery || selectedDateFilter
                      ? 'Try clearing your search query or selecting a different date.'
                      : 'Tap "Record a Thought" above whenever an observation, idea, or reflection crosses your mind during the day.'}
                  </p>
                  {(searchQuery || selectedDateFilter) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setSelectedDateFilter('');
                      }}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-4 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[40px]"
                    >
                      Reset Filters
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {visibleDays.map(({ dateKey, entries: dayEntries }) => {
                    const heading = formatEditorialDateHeading(dateKey);
                    return (
                      <div key={dateKey} className="space-y-5">
                        {/* Day Header */}
                        <div className="flex items-baseline justify-between border-b border-[var(--border-hairline)] pb-3">
                          <div className="flex flex-wrap items-baseline gap-2.5">
                            <h3 className="font-serif-editorial text-2xl font-normal text-[var(--text-primary)]">
                              {heading.primary}
                            </h3>
                            <span className="text-xs text-[var(--text-muted)]">
                              {heading.secondary}
                            </span>
                          </div>
                          <span className="text-xs text-[var(--text-muted)] font-mono-tabular shrink-0">
                            {dayEntries.length}{' '}
                            {dayEntries.length === 1 ? 'entry' : 'entries'}
                          </span>
                        </div>

                        {/* Day's Interstitial Entries */}
                        <div className="divide-y divide-[var(--border-hairline)]">
                          {dayEntries.map((entry) => {
                            const timeLabel = formatTimeOfDay(entry.createdAtIso);
                            const wordCount = entry.finalText
                              .trim()
                              .split(/\s+/)
                              .filter(Boolean).length;

                            return (
                              <article
                                key={entry.id}
                                className="py-6 first:pt-2 last:pb-2 group transition-colors"
                              >
                                {/* Entry Metadata Row — Zero-Pill Unboxed Discipline */}
                                <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] font-mono-tabular">
                                    <span className="font-medium text-[var(--accent-terracotta)]">
                                      {timeLabel}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-sans-ui">
                                      {entry.cleanupMode === 'clean'
                                        ? 'Clean & readable'
                                        : entry.cleanupMode === 'light'
                                        ? 'Light cleanup'
                                        : 'Verbatim transcript'}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span>{wordCount} words</span>
                                    {entry.audioDurationSec > 0 && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span className="inline-flex items-center gap-1">
                                          <Volume2 className="w-3 h-3 text-[var(--accent-sage)]" />
                                          {formatDuration(entry.audioDurationSec)}
                                        </span>
                                      </>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => setSelectedEntry(entry)}
                                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors min-h-[36px]"
                                    >
                                      <Edit3 className="w-3.5 h-3.5" />
                                      <span>Open & Edit</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteEntry(entry.id)}
                                      className="inline-flex items-center justify-center rounded-lg p-1.5 text-[var(--text-muted)] hover:text-[var(--state-error)] hover:bg-[var(--bg-surface)] transition-colors min-h-[36px] min-w-[36px]"
                                      title="Delete entry"
                                      aria-label="Delete entry"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>

                                {/* Entry Body Prose (comfortable 65-75ch reading width) */}
                                <div
                                  onClick={() => setSelectedEntry(entry)}
                                  className="max-w-prose text-base text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap cursor-pointer hover:opacity-95 transition-opacity"
                                >
                                  {highlightMatch(entry.finalText, searchQuery)}
                                </div>

                                {/* If search matched in raw transcription while showing cleaned text */}
                                {searchQuery.trim() &&
                                  !entry.finalText
                                    .toLowerCase()
                                    .includes(searchQuery.trim().toLowerCase()) &&
                                  entry.rawTranscription
                                    .toLowerCase()
                                    .includes(searchQuery.trim().toLowerCase()) && (
                                    <p className="mt-2 text-xs text-[var(--text-secondary)] italic">
                                      Matched in original verbatim transcript:{' '}
                                      {highlightMatch(entry.rawTranscription, searchQuery)}
                                    </p>
                                  )}

                                {/* Inline Retained Audio Player */}
                                {entry.audioId && (
                                  <div className="mt-4 max-w-md">
                                    <AudioPlayer
                                      audioId={entry.audioId}
                                      durationHintSec={entry.audioDurationSec}
                                      compact
                                    />
                                  </div>
                                )}
                              </article>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {/* Pagination for older days */}
                  {hasMoreDays && (
                    <div className="pt-4 text-center">
                      <button
                        type="button"
                        onClick={() => setVisibleDayCount((prev) => prev + DAYS_PER_PAGE)}
                        className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-5 py-2.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[44px]"
                      >
                        <span>
                          Show Older Days ({groupedByDay.length - visibleDayCount} more)
                        </span>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>

          {/* RIGHT MARGIN / EDITORIAL ARCHIVE RAIL (4 cols on desktop) */}
          <aside className="hidden lg:block lg:col-span-4 space-y-6 sticky top-20">
            {/* Quick Search Box */}
            <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-serif-editorial text-lg text-[var(--text-primary)]">
                  Search & Filter
                </h3>
                {(searchQuery || selectedDateFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedDateFilter('');
                    }}
                    className="text-xs text-[var(--accent-terracotta)] hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>

              <div className="relative flex items-center">
                <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3 pointer-events-none" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Find words or ideas..."
                  className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] pl-9 pr-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-sage)] focus:outline-none min-h-[40px]"
                />
              </div>

              {/* Interstitial Journal Summary (Unboxed editorial typography) */}
              <div className="pt-2 border-t border-[var(--border-hairline)] flex items-center justify-between text-xs text-[var(--text-secondary)] font-mono-tabular">
                <span>{entries.length} entries</span>
                <span aria-hidden="true">·</span>
                <span>{allDatesWithCounts.length} days</span>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(totalSpokenSec)} spoken</span>
              </div>
            </div>

            {/* Chronological Day Navigator */}
            <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-serif-editorial text-lg text-[var(--text-primary)]">
                  Journal Days
                </h3>
                <Calendar className="w-4 h-4 text-[var(--text-muted)]" />
              </div>

              {allDatesWithCounts.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                  Dates with recorded thoughts will appear here for rapid navigation.
                </p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                  {allDatesWithCounts.map(({ dateKey, count }) => {
                    const heading = formatEditorialDateHeading(dateKey);
                    const isSelected = selectedDateFilter === dateKey;
                    return (
                      <button
                        key={dateKey}
                        type="button"
                        onClick={() =>
                          setSelectedDateFilter(isSelected ? '' : dateKey)
                        }
                        className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors min-h-[38px] cursor-pointer ${
                          isSelected
                            ? 'bg-[var(--accent-sage-soft)] text-[var(--text-primary)] font-semibold'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        <span className="truncate">{heading.primary}</span>
                        <span className="font-mono-tabular text-[var(--text-muted)] shrink-0 ml-2">
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Minimal Utility & Appearance Controls */}
            <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                  Appearance
                </span>
                <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-subtle)] p-1">
                  <button
                    type="button"
                    onClick={() =>
                      handleUpdateSettings({ ...settings, theme: 'light' })
                    }
                    className={`p-1.5 rounded-md transition-colors ${
                      settings.theme === 'light'
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                    title="Light theme"
                    aria-label="Light theme"
                  >
                    <Sun className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleUpdateSettings({ ...settings, theme: 'dark' })
                    }
                    className={`p-1.5 rounded-md transition-colors ${
                      settings.theme === 'dark'
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                    title="Dark theme"
                    aria-label="Dark theme"
                  >
                    <Moon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--border-hairline)] flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[38px]"
                >
                  <span className="flex items-center gap-2">
                    <Settings className="w-3.5 h-3.5" />
                    <span>Preferences & Export</span>
                  </span>
                  <Download className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                </button>
                <PWAInstallButton />
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* MOBILE BOTTOM NAVIGATION BAR (Thumb-Zone Ergonomics, <= 15% viewport height) */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--border-hairline)] bg-[var(--bg-canvas)]/95 backdrop-blur-md grid grid-cols-4 items-center h-14 px-2"
      >
        <button
          type="button"
          onClick={() => {
            setActiveView('journal');
            setSelectedDateFilter('');
          }}
          className={`flex flex-col items-center justify-center h-full text-[11px] font-medium transition-colors ${
            activeView === 'journal'
              ? 'text-[var(--accent-terracotta)]'
              : 'text-[var(--text-secondary)]'
          }`}
        >
          <BookOpen className="w-4 h-4 mb-0.5" />
          <span>Timeline</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveView('search');
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }}
          className={`flex flex-col items-center justify-center h-full text-[11px] font-medium transition-colors ${
            activeView === 'search'
              ? 'text-[var(--accent-terracotta)]'
              : 'text-[var(--text-secondary)]'
          }`}
        >
          <Search className="w-4 h-4 mb-0.5" />
          <span>Search</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveView('archive')}
          className={`flex flex-col items-center justify-center h-full text-[11px] font-medium transition-colors ${
            activeView === 'archive'
              ? 'text-[var(--accent-terracotta)]'
              : 'text-[var(--text-secondary)]'
          }`}
        >
          <Calendar className="w-4 h-4 mb-0.5" />
          <span>Days</span>
        </button>

        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          className="flex flex-col items-center justify-center h-full text-[11px] font-medium text-[var(--text-secondary)]"
        >
          <Settings className="w-4 h-4 mb-0.5" />
          <span>Settings</span>
        </button>
      </nav>

      {/* ENTRY DETAIL & EDITOR MODAL */}
      {selectedEntry && (
        <EntryDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onUpdateEntry={handleUpdateEntry}
          onDeleteEntry={handleDeleteEntry}
          onDeleteEntryAudio={handleDeleteEntryAudioOnly}
        />
      )}

      {/* SETTINGS & EXPORT MODAL */}
      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          entries={entries}
          user={user}
          onUpdateSettings={handleUpdateSettings}
          onSignIn={async () => {
            await signInWithGoogle();
          }}
          onSignOut={async () => {
            await signOutUser();
          }}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {/* OFFLINE CONNECTIVITY INDICATOR */}
      <OfflineIndicator />
    </div>
  );
}
