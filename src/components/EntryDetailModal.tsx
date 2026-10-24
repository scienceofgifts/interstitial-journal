import React, { useRef, useState } from 'react';
import {
  X,
  Sparkles,
  Trash2,
  Check,
  Undo2,
  Eye,
  GitCompare,
  Edit3,
  AlertCircle,
} from 'lucide-react';
import {
  CleanupMode,
  formatEditorialDateHeading,
  formatTimeOfDay,
  JournalEntry,
} from '../types/journal';
import { AudioPlayer } from './AudioPlayer';
import { computeWordDiff } from '../lib/diffWords';

interface EntryDetailModalProps {
  entry: JournalEntry;
  onClose: () => void;
  onUpdateEntry: (updated: JournalEntry) => Promise<void>;
  onDeleteEntry: (entryId: string) => Promise<void>;
  onDeleteEntryAudio: (entry: JournalEntry) => Promise<void>;
}

export const EntryDetailModal: React.FC<EntryDetailModalProps> = ({
  entry,
  onClose,
  onUpdateEntry,
  onDeleteEntry,
  onDeleteEntryAudio,
}) => {
  const [finalText, setFinalText] = useState(entry.finalText);
  const [rawTranscription, setRawTranscription] = useState(entry.rawTranscription);
  const [cleanedTranscription, setCleanedTranscription] = useState(
    entry.cleanedTranscription
  );
  const [cleanupMode, setCleanupMode] = useState<CleanupMode>(entry.cleanupMode);
  const [ambiguityNotes, setAmbiguityNotes] = useState(entry.ambiguityNotes);
  const [selectedMode, setSelectedMode] = useState<'light' | 'clean'>(
    entry.cleanupMode === 'light' ? 'light' : 'clean'
  );
  const [activeTab, setActiveTab] = useState<'edit' | 'raw' | 'compare'>('edit');

  const [isCleaning, setIsCleaning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const dateHeading = formatEditorialDateHeading(entry.dateKey);
  const createdTime = formatTimeOfDay(entry.createdAtIso);
  const updatedTime = formatTimeOfDay(entry.updatedAtIso);
  const wasModified =
    Math.abs(
      new Date(entry.updatedAtIso).getTime() - new Date(entry.createdAtIso).getTime()
    ) > 5000;

  const handleRunCleanup = async () => {
    const source = rawTranscription.trim() || finalText.trim();
    if (!source) return;

    setIsCleaning(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawTranscription: source,
          mode: selectedMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Cleanup failed.');
      }

      if (!rawTranscription.trim()) {
        setRawTranscription(source);
      }
      const nextCleaned = (data.cleanedTranscription || source).trim();
      setCleanedTranscription(nextCleaned);
      setFinalText(nextCleaned);
      setCleanupMode(selectedMode);
      setAmbiguityNotes(data.ambiguityNotes || '');
      setActiveTab('edit');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to run AI cleanup.');
    } finally {
      setIsCleaning(false);
    }
  };

  const handleSaveChanges = async () => {
    if (isSavingRef.current || isSaving) return;
    if (!finalText.trim()) {
      setErrorMsg('Entry text cannot be empty.');
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    setErrorMsg(null);
    try {
      await onUpdateEntry({
        ...entry,
        rawTranscription: rawTranscription.trim() || finalText.trim(),
        cleanedTranscription: cleanedTranscription.trim(),
        finalText: finalText.trim(),
        cleanupMode,
        ambiguityNotes: ambiguityNotes.trim(),
        updatedAtIso: new Date().toISOString(),
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update entry.');
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const diffTokens =
    activeTab === 'compare' && rawTranscription && cleanedTranscription
      ? computeWordDiff(rawTranscription, cleanedTranscription)
      : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-6 md:p-8 shadow-xl my-auto max-h-[90vh] overflow-y-auto space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-hairline)] pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] font-mono-tabular">
              <span>{createdTime}</span>
              <span aria-hidden="true">·</span>
              <span>{dateHeading.secondary}</span>
              {wasModified && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Edited {updatedTime}</span>
                </>
              )}
            </div>
            <h2 className="mt-1 font-serif-editorial text-2xl text-[var(--text-primary)]">
              {dateHeading.primary}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center"
            aria-label="Close entry"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Retained Audio Player */}
        {entry.audioId && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>Retained Voice Recording</span>
              <button
                type="button"
                onClick={() => onDeleteEntryAudio(entry)}
                className="text-[var(--text-muted)] hover:text-[var(--state-error)] transition-colors"
              >
                Delete audio only
              </button>
            </div>
            <AudioPlayer
              audioId={entry.audioId}
              durationHintSec={entry.audioDurationSec}
            />
          </div>
        )}

        {errorMsg && (
          <div className="flex items-center gap-2 rounded-xl border border-[var(--state-error)]/40 bg-[var(--accent-terracotta-soft)] px-4 py-3 text-xs text-[var(--text-primary)]">
            <AlertCircle className="w-4 h-4 text-[var(--state-error)] shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* AI Cleanup Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">Cleanup:</span>
            <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-subtle)] p-1">
              <button
                type="button"
                onClick={() => setSelectedMode('light')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  selectedMode === 'light'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                Light cleanup
              </button>
              <button
                type="button"
                onClick={() => setSelectedMode('clean')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  selectedMode === 'clean'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                Clean & readable
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={handleRunCleanup}
            disabled={isCleaning}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent-sage)] hover:bg-[var(--accent-sage-hover)] px-3.5 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 min-h-[38px]"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isCleaning ? 'Improving...' : 'Improve Transcription'}</span>
          </button>
        </div>

        {ambiguityNotes && (
          <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-2.5 text-xs text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--state-warning)]">
              Ambiguous passage note:{' '}
            </span>
            {ambiguityNotes}
          </div>
        )}

        {/* View Tabs */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-2">
            <div className="flex items-center gap-1 rounded-lg bg-[var(--bg-surface)] p-1">
              <button
                type="button"
                onClick={() => setActiveTab('edit')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'edit'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Entry Text</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('raw')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'raw'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Original Raw</span>
              </button>
              {cleanedTranscription && (
                <button
                  type="button"
                  onClick={() => setActiveTab('compare')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    activeTab === 'compare'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                      : 'text-[var(--text-secondary)]'
                  }`}
                >
                  <GitCompare className="w-3.5 h-3.5" />
                  <span>Compare</span>
                </button>
              )}
            </div>

            {rawTranscription && rawTranscription !== finalText && (
              <button
                type="button"
                onClick={() => {
                  setFinalText(rawTranscription);
                  setCleanupMode('none');
                  setActiveTab('edit');
                }}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>Recover original raw</span>
              </button>
            )}
          </div>

          {activeTab === 'edit' && (
            <textarea
              value={finalText}
              onChange={(e) => setFinalText(e.target.value)}
              rows={8}
              className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-4 text-base text-[var(--text-primary)] leading-relaxed focus:border-[var(--accent-sage)] focus:outline-none resize-y"
            />
          )}

          {activeTab === 'raw' && (
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-base text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
              {rawTranscription || 'No separate raw transcription stored.'}
            </div>
          )}

          {activeTab === 'compare' && (
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-base text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
              {diffTokens.map((tok, idx) =>
                tok.type === 'removed' ? (
                  <del
                    key={idx}
                    className="bg-[var(--state-error)]/15 text-[var(--state-error)] px-0.5 rounded-xs"
                  >
                    {tok.text}
                  </del>
                ) : tok.type === 'added' ? (
                  <ins
                    key={idx}
                    className="bg-[var(--state-success)]/15 text-[var(--state-success)] no-underline font-medium px-0.5 rounded-xs"
                  >
                    {tok.text}
                  </ins>
                ) : (
                  <span key={idx}>{tok.text}</span>
                )
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[var(--border-hairline)]">
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[var(--state-error)] hover:bg-[var(--accent-terracotta-soft)] transition-colors min-h-[40px]"
            >
              <Trash2 className="w-4 h-4" />
              <span>Delete Entry</span>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--state-error)] font-medium">
                Delete entry & audio permanently?
              </span>
              <button
                type="button"
                onClick={async () => {
                  await onDeleteEntry(entry.id);
                  onClose();
                }}
                className="rounded-lg bg-[var(--state-error)] px-3 py-1.5 text-xs font-semibold text-white min-h-[36px]"
              >
                Confirm Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] min-h-[36px]"
              >
                Cancel
              </button>
            </div>
          )}

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[var(--border-strong)] px-4 py-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors min-h-[42px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveChanges}
              disabled={isSaving || !finalText.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--text-primary)] px-5 py-2 text-xs font-semibold text-[var(--bg-canvas)] hover:opacity-90 transition-opacity disabled:opacity-40 min-h-[42px]"
            >
              <Check className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Changes'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
