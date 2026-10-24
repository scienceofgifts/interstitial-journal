import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  Square,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Check,
  AlertCircle,
  Upload,
  Volume2,
  X,
  FileAudio,
  Undo2,
  Eye,
  GitCompare,
  Edit3,
} from 'lucide-react';
import {
  ActiveDraft,
  AudioRetentionPreference,
  CleanupMode,
  formatDuration,
  getLocalDateKey,
  JournalEntry,
} from '../types/journal';
import {
  base64ToBlob,
  blobToBase64,
  cacheLocalAudioBlob,
  clearActiveDraft,
  deleteCachedLocalAudioBlob,
  loadActiveDraft,
  saveActiveDraft,
} from '../lib/draftStorage';
import { AudioPlayer } from './AudioPlayer';
import { computeWordDiff } from '../lib/diffWords';

interface VoiceRecorderStudioProps {
  defaultCleanupMode: 'light' | 'clean';
  audioRetention: AudioRetentionPreference;
  ownerId: string;
  onSaveEntry: (entry: JournalEntry, audioBlob?: Blob) => Promise<void>;
}

type StudioStage = 'idle' | 'recording' | 'transcribing' | 'review';
type EditorTab = 'edit' | 'raw' | 'compare';

export const VoiceRecorderStudio: React.FC<VoiceRecorderStudioProps> = ({
  defaultCleanupMode,
  audioRetention,
  ownerId,
  onSaveEntry,
}) => {
  const [stage, setStage] = useState<StudioStage>('idle');
  const [isPaused, setIsPaused] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [processingSeconds, setProcessingSeconds] = useState(0);

  // Audio & Draft state
  const [draftId, setDraftId] = useState<string>('');
  const [audioId, setAudioId] = useState<string>('');
  const [audioBlob, setAudioBlob] = useState<Blob | undefined>(undefined);
  const [audioMimeType, setAudioMimeType] = useState<string>('audio/webm');
  const [audioDurationSec, setAudioDurationSec] = useState<number>(0);

  // Transcription & Cleanup state
  const [rawTranscription, setRawTranscription] = useState<string>('');
  const [cleanedTranscription, setCleanedTranscription] = useState<string>('');
  const [finalText, setFinalText] = useState<string>('');
  const [cleanupMode, setCleanupMode] = useState<CleanupMode>('none');
  const [selectedCleanupPref, setSelectedCleanupPref] = useState<'light' | 'clean'>(
    defaultCleanupMode
  );
  const [ambiguityNotes, setAmbiguityNotes] = useState<string>('');
  const [editorTab, setEditorTab] = useState<EditorTab>('edit');
  const [retainAudioForEntry, setRetainAudioForEntry] = useState<boolean>(
    audioRetention === 'keep'
  );

  // Status & Error state
  const [isCleaning, setIsCleaning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSynthesizingSample, setIsSynthesizingSample] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<ActiveDraft | null>(null);

  // MediaRecorder & Web Audio API refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const recordingSecondsRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const isPausedRef = useRef<boolean>(false);
  const isSavingRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSelectedCleanupPref(defaultCleanupMode);
  }, [defaultCleanupMode]);

  useEffect(() => {
    setRetainAudioForEntry(audioRetention === 'keep');
  }, [audioRetention]);

  // Check for interrupted draft on mount
  useEffect(() => {
    loadActiveDraft().then((saved) => {
      if (saved && (saved.rawTranscription || saved.finalText || saved.audioBlob)) {
        setRecoverableDraft(saved);
      }
    });
    return () => {
      stopMediaResources();
    };
  }, []);

  // Processing timer for transcription / cleanup feedback
  useEffect(() => {
    if (stage === 'transcribing' || isCleaning) {
      setProcessingSeconds(0);
      const id = window.setInterval(() => {
        setProcessingSeconds((prev) => prev + 1);
      }, 1000);
      return () => window.clearInterval(id);
    }
  }, [stage, isCleaning]);

  // Persist active review state to IndexedDB automatically
  useEffect(() => {
    if (stage === 'review' && draftId) {
      saveActiveDraft({
        id: draftId,
        audioId,
        audioBlob,
        audioMimeType,
        audioDurationSec,
        rawTranscription,
        cleanedTranscription,
        finalText,
        cleanupMode,
        ambiguityNotes,
        stage: 'review',
        createdAtIso: new Date().toISOString(),
      });
    }
  }, [
    stage,
    draftId,
    audioId,
    audioBlob,
    audioMimeType,
    audioDurationSec,
    rawTranscription,
    cleanedTranscription,
    finalText,
    cleanupMode,
    ambiguityNotes,
  ]);

  const stopMediaResources = () => {
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  const drawWaveform = () => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const renderFrame = () => {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      analyser.getByteFrequencyData(dataArray);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const barCount = 42;
      const step = Math.floor(bufferLength / barCount);
      const gap = 4;
      const barWidth = Math.max(3, (width - (barCount - 1) * gap) / barCount);

      for (let i = 0; i < barCount; i++) {
        const value = isPausedRef.current ? 8 : dataArray[i * step] || 6;
        const normalized = Math.max(0.08, value / 255);
        const barHeight = Math.max(6, normalized * (height - 8));
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;

        ctx.fillStyle = isPausedRef.current
          ? '#857E74'
          : normalized > 0.45
          ? '#B85D3B'
          : '#3F6152';

        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 2);
        ctx.fill();
      }
    };

    renderFrame();
  };

  const startRecording = async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMsg(
        'Audio recording is not supported in this browser. You can upload an audio file or try a synthesized voice sample below.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // Determine supported MIME type
      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      let chosenMime = '';
      for (const t of preferredTypes) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
          chosenMime = t;
          break;
        }
      }

      const recorder = chosenMime
        ? new MediaRecorder(stream, { mimeType: chosenMime })
        : new MediaRecorder(stream);

      const resolvedMime = recorder.mimeType || chosenMime || 'audio/webm';
      setAudioMimeType(resolvedMime);
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const finalDuration = Math.max(1, recordingSecondsRef.current);
        stopMediaResources();

        const recordedBlob = new Blob(audioChunksRef.current, { type: resolvedMime });
        if (recordedBlob.size === 0) {
          setErrorMsg('The recording was empty. Please check your microphone and try again.');
          setStage('idle');
          return;
        }

        await handleCapturedAudioBlob(recordedBlob, resolvedMime, finalDuration);
      };

      recorder.onerror = () => {
        stopMediaResources();
        setErrorMsg('Recording was interrupted by a microphone error.');
        setStage('idle');
      };

      // Set up Web Audio API AnalyserNode for live waveform
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyserRef.current = analyser;

      mediaRecorderRef.current = recorder;
      recorder.start(250);

      const newDraftId = `entry_${Date.now()}`;
      setDraftId(newDraftId);
      setRecordingSeconds(0);
      recordingSecondsRef.current = 0;
      setIsPaused(false);
      isPausedRef.current = false;
      setStage('recording');

      timerIntervalRef.current = window.setInterval(() => {
        if (!isPausedRef.current) {
          recordingSecondsRef.current += 1;
          setRecordingSeconds(recordingSecondsRef.current);
        }
      }, 1000);

      window.requestAnimationFrame(() => {
        drawWaveform();
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setErrorMsg(
          'Microphone permission was denied. Please allow microphone access in your browser address bar, or upload/test with a voice recording below.'
        );
      } else {
        setErrorMsg(
          'Could not access microphone. Please ensure a microphone is connected or use the sample voice memo option below.'
        );
      }
    }
  };

  const togglePauseRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      setIsPaused(true);
      isPausedRef.current = true;
    } else if (recorder.state === 'paused') {
      recorder.resume();
      setIsPaused(false);
      isPausedRef.current = false;
    }
  };

  const stopRecordingAndTranscribe = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const cancelRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    stopMediaResources();
    setStage('idle');
    setErrorMsg(null);
  };

  const handleCapturedAudioBlob = async (
    blob: Blob,
    mimeType: string,
    durationSec: number
  ) => {
    const generatedEntryId = `entry_${Date.now()}`;
    const generatedAudioId = `aud_${Date.now()}`;

    setDraftId(generatedEntryId);
    setAudioId(generatedAudioId);
    setAudioBlob(blob);
    setAudioMimeType(mimeType);
    setAudioDurationSec(durationSec);
    setRawTranscription('');
    setCleanedTranscription('');
    setFinalText('');
    setCleanupMode('none');
    setAmbiguityNotes('');
    setStage('transcribing');
    setErrorMsg(null);

    // 1. Preserve audio locally in IndexedDB immediately so it is never lost
    await cacheLocalAudioBlob(generatedAudioId, blob, mimeType);
    await saveActiveDraft({
      id: generatedEntryId,
      audioId: generatedAudioId,
      audioBlob: blob,
      audioMimeType: mimeType,
      audioDurationSec: durationSec,
      rawTranscription: '',
      cleanedTranscription: '',
      finalText: '',
      cleanupMode: 'none',
      ambiguityNotes: '',
      stage: 'transcribing',
      createdAtIso: new Date().toISOString(),
    });
    setRecoverableDraft(null);

    // 2. Upload audio to server object store and transcribe
    await performTranscription(blob, mimeType, generatedAudioId, durationSec);
  };

  const performTranscription = async (
    blobToTranscribe: Blob,
    mimeType: string,
    targetAudioId: string,
    durationSec: number
  ) => {
    setStage('transcribing');
    setErrorMsg(null);

    try {
      const base64Audio = await blobToBase64(blobToTranscribe);

      // Persist audio in server object store so it survives refresh
      await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioId: targetAudioId,
          mimeType,
          dataBase64: base64Audio,
          durationSec,
        }),
      }).catch(() => {
        // Non-fatal if offline; local IndexedDB blob is still preserved
      });

      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: base64Audio,
          audioId: targetAudioId,
          mimeType,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Speech-to-text transcription failed.');
      }

      const rawText = (data.rawTranscription || '').trim();
      setRawTranscription(rawText);
      setFinalText(rawText);
      setCleanupMode('none');
      setEditorTab('edit');
      setStage('review');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Transcription request failed. Your recording is safely preserved.';
      setErrorMsg(msg);
      // Transition to review stage so user can replay audio, retry transcription, or type
      setStage('review');
    }
  };

  const handleImproveTranscription = async (modeToUse: 'light' | 'clean' = selectedCleanupPref) => {
    const sourceText = rawTranscription.trim() || finalText.trim();
    if (!sourceText) {
      setErrorMsg('Please transcribe or enter text before running AI cleanup.');
      return;
    }

    setIsCleaning(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawTranscription: sourceText,
          mode: modeToUse,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'AI transcription cleanup failed.');
      }

      // Ensure rawTranscription is never lost if user started from manual text
      if (!rawTranscription.trim()) {
        setRawTranscription(sourceText);
      }

      const cleaned = (data.cleanedTranscription || sourceText).trim();
      setCleanedTranscription(cleaned);
      setFinalText(cleaned);
      setCleanupMode(modeToUse);
      setAmbiguityNotes(data.ambiguityNotes || '');
      // Cleaned transcription is the default view after processing
      setEditorTab('edit');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Could not improve transcription right now. Your original transcript is intact.'
      );
    } finally {
      setIsCleaning(false);
    }
  };

  const handleRestoreRaw = () => {
    if (!rawTranscription) return;
    setFinalText(rawTranscription);
    setCleanupMode('none');
    setEditorTab('edit');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg('Audio file must be under 20MB.');
      return;
    }

    const mime = file.type || 'audio/webm';
    await handleCapturedAudioBlob(file, mime, 15);
  };

  const handleGenerateVoiceSample = async () => {
    setIsSynthesizingSample(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/sample-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptType: 'reflection' }),
      });
      const data = await res.json();
      if (!res.ok || !data.audioBase64) {
        throw new Error(data.error || 'Failed to generate spoken voice sample.');
      }
      const wavBlob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/wav');
      await handleCapturedAudioBlob(
        wavBlob,
        data.mimeType || 'audio/wav',
        data.durationSec || 16
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not synthesize voice sample.'
      );
    } finally {
      setIsSynthesizingSample(false);
    }
  };

  const handleResumeDraft = () => {
    if (!recoverableDraft) return;
    setDraftId(recoverableDraft.id || `entry_${Date.now()}`);
    setAudioId(recoverableDraft.audioId || '');
    setAudioBlob(recoverableDraft.audioBlob);
    setAudioMimeType(recoverableDraft.audioMimeType || 'audio/webm');
    setAudioDurationSec(recoverableDraft.audioDurationSec || 0);
    setRawTranscription(recoverableDraft.rawTranscription || '');
    setCleanedTranscription(recoverableDraft.cleanedTranscription || '');
    setFinalText(
      recoverableDraft.finalText ||
        recoverableDraft.cleanedTranscription ||
        recoverableDraft.rawTranscription ||
        ''
    );
    setCleanupMode(recoverableDraft.cleanupMode || 'none');
    setAmbiguityNotes(recoverableDraft.ambiguityNotes || '');
    setStage('review');
    setRecoverableDraft(null);
  };

  const handleDiscardDraft = async () => {
    if (recoverableDraft?.audioId) {
      await deleteCachedLocalAudioBlob(recoverableDraft.audioId);
    }
    await clearActiveDraft();
    setRecoverableDraft(null);
    setStage('idle');
  };

  const handleSave = async () => {
    if (isSavingRef.current || isSaving) return;

    const textToSave = finalText.trim() || cleanedTranscription.trim() || rawTranscription.trim();
    if (!textToSave) {
      setErrorMsg('Cannot save an empty journal entry.');
      return;
    }

    isSavingRef.current = true;
    setIsSaving(true);
    setErrorMsg(null);

    try {
      const nowIso = new Date().toISOString();
      let finalAudioId = audioId;
      let finalMime = audioMimeType;

      // If user chose not to retain original audio after approval, delete it now
      if (!retainAudioForEntry && audioId) {
        void deleteCachedLocalAudioBlob(audioId);
        void fetch(`/api/audio/${encodeURIComponent(audioId)}`, {
          method: 'DELETE',
        }).catch(() => {});
        finalAudioId = '';
        finalMime = '';
      }

      const newEntry: JournalEntry = {
        id: draftId || `entry_${Date.now()}`,
        ownerId: ownerId || 'local',
        rawTranscription: rawTranscription.trim() || textToSave,
        cleanedTranscription: cleanedTranscription.trim(),
        finalText: textToSave,
        cleanupMode,
        ambiguityNotes: ambiguityNotes.trim(),
        audioId: finalAudioId,
        audioMimeType: finalMime,
        audioDurationSec: finalAudioId ? audioDurationSec : 0,
        dateKey: getLocalDateKey(nowIso),
        createdAtIso: nowIso,
        updatedAtIso: nowIso,
      };

      await onSaveEntry(newEntry, retainAudioForEntry ? audioBlob : undefined);

      // Reset studio back to idle immediately after save succeeds
      setStage('idle');
      setDraftId('');
      setAudioId('');
      setAudioBlob(undefined);
      setRawTranscription('');
      setCleanedTranscription('');
      setFinalText('');
      setCleanupMode('none');
      setAmbiguityNotes('');
      setRecoverableDraft(null);

      void clearActiveDraft();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Failed to save entry to persistent database. Your work is still preserved here.'
      );
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const diffTokens =
    editorTab === 'compare' && rawTranscription && cleanedTranscription
      ? computeWordDiff(rawTranscription, cleanedTranscription)
      : [];

  return (
    <section
      aria-label="Voice Capture Studio"
      className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-5 md:p-7 shadow-xs transition-all"
    >
      {/* Hidden audio upload input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* Interrupted Draft Recovery Banner */}
      {stage === 'idle' && recoverableDraft && (
        <div className="mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3">
          <div className="text-xs text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              Unsaved voice note recovered
            </span>{' '}
            · Captured at{' '}
            {new Date(recoverableDraft.createdAtIso).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleResumeDraft}
              className="rounded-lg bg-[var(--accent-sage)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-sage-hover)] transition-colors min-h-[36px]"
            >
              Resume Note
            </button>
            <button
              type="button"
              onClick={handleDiscardDraft}
              className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors min-h-[36px]"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* STAGE 1: IDLE — Prominent 1-Tap Voice Capture */}
      {stage === 'idle' && (
        <div className="flex flex-col items-center text-center py-3 md:py-5">
          <p className="text-xs tracking-widest uppercase text-[var(--text-muted)] font-mono-tabular mb-2">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Interstitial Entry
          </p>
          <h2 className="font-serif-editorial text-2xl md:text-3xl font-normal text-[var(--text-primary)] balance-text max-w-lg">
            What is on your mind right now?
          </h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-md leading-relaxed">
            Speak naturally. Interstitial captures your voice, transcribes your words verbatim, and refines the prose while preserving your voice.
          </p>

          <div className="mt-6 flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto justify-center">
            <button
              type="button"
              onClick={startRecording}
              className="group relative flex items-center justify-center gap-3 rounded-xl bg-[var(--accent-terracotta)] hover:bg-[var(--accent-terracotta-hover)] px-7 py-4 text-sm font-semibold text-[var(--accent-contrast,#ffffff)] shadow-sm transition-all active:scale-[0.99] min-h-[52px] w-full sm:w-auto cursor-pointer"
            >
              <Mic className="w-5 h-5" />
              <span>Record a Thought</span>
            </button>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-4 text-xs text-[var(--text-muted)]">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors py-1.5 px-2"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload voice memo</span>
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={handleGenerateVoiceSample}
              disabled={isSynthesizingSample}
              className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] transition-colors py-1.5 px-2 disabled:opacity-50"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>
                {isSynthesizingSample
                  ? 'Synthesizing spoken audio...'
                  : 'Test with sample spoken voice'}
              </span>
            </button>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="mt-5 flex items-start gap-2.5 rounded-xl border border-[var(--state-error)]/40 bg-[var(--accent-terracotta-soft)] px-4 py-3 text-left text-xs text-[var(--text-primary)] max-w-lg"
            >
              <AlertCircle className="w-4 h-4 text-[var(--state-error)] shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      )}

      {/* STAGE 2: RECORDING — Live Waveform & Tactile Controls */}
      {stage === 'recording' && (
        <div className="flex flex-col items-center py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-terracotta)]">
            <Mic className="w-4 h-4" />
            <span>{isPaused ? 'Recording Paused' : 'Listening — Speak naturally'}</span>
          </div>

          <div className="mt-2 font-mono-tabular text-4xl md:text-5xl font-medium text-[var(--text-primary)] tracking-tight">
            {formatDuration(recordingSeconds)}
          </div>

          <div className="my-5 w-full max-w-md rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3">
            <canvas
              ref={canvasRef}
              width={400}
              height={64}
              className="w-full h-16 block"
            />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 w-full">
            <button
              type="button"
              onClick={cancelRecording}
              className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors min-h-[46px]"
            >
              <X className="w-4 h-4" />
              <span>Cancel</span>
            </button>

            <button
              type="button"
              onClick={togglePauseRecording}
              className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[46px]"
            >
              {isPaused ? (
                <>
                  <Play className="w-4 h-4 text-[var(--accent-sage)]" />
                  <span>Resume</span>
                </>
              ) : (
                <>
                  <Pause className="w-4 h-4 text-[var(--accent-terracotta)]" />
                  <span>Pause</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={stopRecordingAndTranscribe}
              className="flex items-center justify-center gap-2 rounded-xl bg-[var(--accent-sage)] hover:bg-[var(--accent-sage-hover)] px-6 py-3 text-xs font-semibold text-white shadow-xs transition-colors min-h-[46px]"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>Stop & Transcribe</span>
            </button>
          </div>
        </div>
      )}

      {/* STAGE 3: TRANSCRIBING — Dedicated Speech-to-Text Processing */}
      {stage === 'transcribing' && (
        <div className="flex flex-col items-center text-center py-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-sage-soft)] text-[var(--accent-sage)] mb-4">
            <FileAudio className="w-6 h-6 animate-pulse" />
          </div>
          <h3 className="font-serif-editorial text-xl text-[var(--text-primary)]">
            Transcribing your voice note...
          </h3>
          <p className="mt-1.5 text-xs text-[var(--text-secondary)] max-w-sm">
            Processing audio with Gemini 3.5 Flash-Lite ({formatDuration(processingSeconds)} elapsed). Your original audio is safely preserved.
          </p>
        </div>
      )}

      {/* STAGE 4: REVIEW, AI CLEANUP & EDITING */}
      {stage === 'review' && (
        <div className="space-y-5">
          {/* Top Bar: Audio Player + Retry Transcription if needed */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>Recorded Voice Note · {formatDuration(audioDurationSec)}</span>
              {audioBlob && (
                <button
                  type="button"
                  onClick={() =>
                    performTranscription(audioBlob, audioMimeType, audioId, audioDurationSec)
                  }
                  className="inline-flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors py-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Retry Transcription</span>
                </button>
              )}
            </div>
            {(audioBlob || audioId) && (
              <AudioPlayer
                audioId={audioId}
                audioBlob={audioBlob}
                durationHintSec={audioDurationSec}
              />
            )}
          </div>

          {/* Error Banner with safe recovery */}
          {errorMsg && (
            <div
              role="alert"
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[var(--state-error)]/40 bg-[var(--accent-terracotta-soft)] px-4 py-3 text-xs text-[var(--text-primary)]"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-[var(--state-error)] shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
              {audioBlob && (
                <button
                  type="button"
                  onClick={() =>
                    performTranscription(audioBlob, audioMimeType, audioId, audioDurationSec)
                  }
                  className="rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-xs font-medium text-[var(--bg-canvas)] shrink-0 min-h-[36px]"
                >
                  Retry Now
                </button>
              )}
            </div>
          )}

          {/* AI Cleanup Control Bar */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Cleanup style:
              </span>
              <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-subtle)] p-1">
                <button
                  type="button"
                  onClick={() => setSelectedCleanupPref('light')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                    selectedCleanupPref === 'light'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title="Corrects punctuation and obvious transcription errors while preserving natural wording"
                >
                  Light cleanup
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedCleanupPref('clean')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                    selectedCleanupPref === 'clean'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title="Removes unnecessary fillers, improves sentence flow, and produces a polished faithful transcript"
                >
                  Clean & readable
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleImproveTranscription(selectedCleanupPref)}
              disabled={isCleaning || (!rawTranscription.trim() && !finalText.trim())}
              className="flex items-center justify-center gap-2 rounded-lg bg-[var(--accent-sage)] hover:bg-[var(--accent-sage-hover)] px-4 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                {isCleaning
                  ? `Improving (${processingSeconds}s)...`
                  : cleanupMode !== 'none'
                  ? 'Re-run Improve Transcription'
                  : 'Improve Transcription'}
              </span>
            </button>
          </div>

          {/* Ambiguity Notes Callout (when AI flags uncertain terms rather than guessing) */}
          {ambiguityNotes && (
            <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3 text-xs text-[var(--text-secondary)] leading-relaxed">
              <span className="font-semibold text-[var(--state-warning)]">
                Note on ambiguous passages:{' '}
              </span>
              {ambiguityNotes}
            </div>
          )}

          {/* Transcript View Switcher & Editor */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-2.5">
              <div className="flex items-center gap-1 rounded-lg bg-[var(--bg-surface)] p-1">
                <button
                  type="button"
                  onClick={() => setEditorTab('edit')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                    editorTab === 'edit'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>
                    {cleanupMode === 'clean'
                      ? 'Cleaned Transcript'
                      : cleanupMode === 'light'
                      ? 'Lightly Cleaned'
                      : 'Transcript Editor'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setEditorTab('raw')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                    editorTab === 'raw'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Original Raw</span>
                </button>

                {cleanedTranscription && (
                  <button
                    type="button"
                    onClick={() => setEditorTab('compare')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap min-h-[34px] ${
                      editorTab === 'compare'
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <GitCompare className="w-3.5 h-3.5" />
                    <span>Compare</span>
                  </button>
                )}
              </div>

              {cleanupMode !== 'none' && rawTranscription && (
                <button
                  type="button"
                  onClick={handleRestoreRaw}
                  className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors py-1 px-2"
                  title="Revert editor to verbatim raw transcription"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>Use raw transcription</span>
                </button>
              )}
            </div>

            {/* Tab 1: Editable Final Transcript */}
            {editorTab === 'edit' && (
              <div>
                <textarea
                  value={finalText}
                  onChange={(e) => setFinalText(e.target.value)}
                  rows={6}
                  placeholder="Your transcribed thought will appear here. You can also edit or type directly..."
                  className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-canvas)] p-4 text-base text-[var(--text-primary)] leading-relaxed focus:border-[var(--accent-sage)] focus:outline-none resize-y"
                />
                <div className="mt-1.5 flex items-center justify-between text-xs text-[var(--text-muted)]">
                  <span>
                    {cleanupMode === 'none'
                      ? 'Showing verbatim transcription'
                      : cleanupMode === 'light'
                      ? 'Improved with Light cleanup · Original raw transcription preserved'
                      : 'Improved with Clean & readable mode · Original raw transcription preserved'}
                  </span>
                  <span className="font-mono-tabular">
                    {finalText.trim() ? finalText.trim().split(/\s+/).length : 0} words
                  </span>
                </div>
              </div>
            )}

            {/* Tab 2: Read-Only Preserved Original Raw Transcription */}
            {editorTab === 'raw' && (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                  <span>Preserved Verbatim Raw Transcription</span>
                  <button
                    type="button"
                    onClick={handleRestoreRaw}
                    className="font-medium text-[var(--accent-sage)] hover:underline"
                  >
                    Copy raw to editor
                  </button>
                </div>
                <p className="text-base text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
                  {rawTranscription || 'No raw transcription recorded.'}
                </p>
              </div>
            )}

            {/* Tab 3: Word-Level Diff Comparison */}
            {editorTab === 'compare' && (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                  <span>Comparison: Raw vs. Cleaned</span>
                  <span>
                    <del className="text-[var(--state-error)] mr-2">Removed filler/error</del>
                    <ins className="text-[var(--state-success)] no-underline font-medium">
                      Refined addition
                    </ins>
                  </span>
                </div>
                <div className="text-base leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">
                  {diffTokens.map((tok, i) => {
                    if (tok.type === 'removed') {
                      return (
                        <del
                          key={i}
                          className="bg-[var(--state-error)]/15 text-[var(--state-error)] px-0.5 rounded-xs"
                        >
                          {tok.text}
                        </del>
                      );
                    }
                    if (tok.type === 'added') {
                      return (
                        <ins
                          key={i}
                          className="bg-[var(--state-success)]/15 text-[var(--state-success)] no-underline font-medium px-0.5 rounded-xs"
                        >
                          {tok.text}
                        </ins>
                      );
                    }
                    return <span key={i}>{tok.text}</span>;
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Bottom Action Bar: Audio Retention Toggle + Discard / Save Entry */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-[var(--border-hairline)]">
            <label className="flex items-center gap-2.5 text-xs text-[var(--text-secondary)] cursor-pointer select-none min-h-[40px]">
              <input
                type="checkbox"
                checked={retainAudioForEntry}
                onChange={(e) => setRetainAudioForEntry(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--border-strong)] accent-[var(--accent-sage)]"
              />
              <span>
                Retain original audio recording with entry
              </span>
            </label>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={async () => {
                  if (audioId) {
                    await deleteCachedLocalAudioBlob(audioId);
                    await fetch(`/api/audio/${encodeURIComponent(audioId)}`, {
                      method: 'DELETE',
                    }).catch(() => {});
                  }
                  await clearActiveDraft();
                  setStage('idle');
                  setErrorMsg(null);
                }}
                className="rounded-xl border border-[var(--border-strong)] px-4 py-2.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors min-h-[44px]"
              >
                Discard
              </button>

              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving || !finalText.trim()}
                className="flex items-center justify-center gap-2 rounded-xl bg-[var(--text-primary)] hover:opacity-90 px-6 py-2.5 text-xs font-semibold text-[var(--bg-canvas)] transition-opacity disabled:opacity-40 min-h-[44px] cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{isSaving ? 'Saving to Journal...' : 'Save to Journal'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
