import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2, Trash2, RotateCcw } from 'lucide-react';
import { formatDuration } from '../types/journal';
import { getCachedLocalAudioBlob } from '../lib/draftStorage';

interface AudioPlayerProps {
  audioId?: string;
  audioBlob?: Blob;
  durationHintSec?: number;
  onDeleteAudio?: () => void;
  compact?: boolean;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  audioId,
  audioBlob,
  durationHintSec = 0,
  onDeleteAudio,
  compact = false,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationHintSec);
  const [playbackRate, setPlaybackRate] = useState<1 | 1.25 | 1.5>(1);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let activeObjectUrl: string | null = null;
    let cancelled = false;
    setLoadError(false);

    async function resolveSource() {
      if (audioBlob) {
        activeObjectUrl = URL.createObjectURL(audioBlob);
        if (!cancelled) setSrcUrl(activeObjectUrl);
        return;
      }

      if (audioId) {
        const cached = await getCachedLocalAudioBlob(audioId);
        if (cached && !cancelled) {
          activeObjectUrl = URL.createObjectURL(cached);
          setSrcUrl(activeObjectUrl);
          return;
        }
        if (!cancelled) {
          setSrcUrl(`/api/audio/${encodeURIComponent(audioId)}`);
        }
      } else {
        setSrcUrl(null);
      }
    }

    resolveSource();

    return () => {
      cancelled = true;
      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl);
      }
    };
  }, [audioId, audioBlob]);

  useEffect(() => {
    if (durationHintSec > 0 && (!duration || !Number.isFinite(duration))) {
      setDuration(durationHintSec);
    }
  }, [durationHintSec, duration]);

  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el || !srcUrl) return;
    try {
      if (isPlaying) {
        el.pause();
        setIsPlaying(false);
      } else {
        await el.play();
        setIsPlaying(true);
      }
    } catch (err) {
      console.error('Playback error:', err);
      setLoadError(true);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    const nextTime = Number(e.target.value);
    setCurrentTime(nextTime);
    if (el && Number.isFinite(nextTime)) {
      el.currentTime = nextTime;
    }
  };

  const cycleSpeed = () => {
    const nextSpeed: 1 | 1.25 | 1.5 =
      playbackRate === 1 ? 1.25 : playbackRate === 1.25 ? 1.5 : 1;
    setPlaybackRate(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  };

  const restartAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    setCurrentTime(0);
  };

  if (!srcUrl) return null;

  const effectiveDuration =
    Number.isFinite(duration) && duration > 0 ? duration : Math.max(durationHintSec, 1);

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] ${
        compact ? 'px-3 py-2' : 'px-4 py-3'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <audio
        ref={audioRef}
        src={srcUrl}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setDuration(d);
          }
        }}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime);
        }}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        onError={() => {
          setIsPlaying(false);
          setLoadError(true);
        }}
      />

      <button
        type="button"
        onClick={togglePlay}
        disabled={loadError}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent-sage)] text-white hover:bg-[var(--accent-sage-hover)] transition-colors disabled:opacity-40"
        aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
      </button>

      <div className="flex-1 min-w-0">
        {loadError ? (
          <p className="text-xs text-[var(--state-error)]">
            Original audio file is no longer available on this device.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-mono-tabular">
              <span className="flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5 text-[var(--accent-sage)]" />
                <span>{formatDuration(currentTime)}</span>
              </span>
              <span>{formatDuration(effectiveDuration)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={effectiveDuration}
              step={0.1}
              value={Math.min(currentTime, effectiveDuration)}
              onChange={handleSeek}
              className="w-full h-1.5 accent-[var(--accent-sage)] cursor-pointer bg-[var(--border-strong)] rounded-lg"
              aria-label="Seek audio position"
            />
          </div>
        )}
      </div>

      {!loadError && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={cycleSpeed}
            className="px-2 py-1.5 rounded-md text-xs font-mono-tabular font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[36px]"
            title="Change playback speed"
          >
            {playbackRate}x
          </button>
          {!compact && (
            <button
              type="button"
              onClick={restartAudio}
              className="p-2 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
              title="Restart playback"
              aria-label="Restart playback"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {onDeleteAudio && (
        <button
          type="button"
          onClick={onDeleteAudio}
          className="p-2 rounded-md text-[var(--text-muted)] hover:text-[var(--state-error)] hover:bg-[var(--bg-subtle)] transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0"
          title="Delete retained audio recording"
          aria-label="Delete retained audio recording"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};
