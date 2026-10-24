import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 right-4 md:right-auto z-50 flex items-center gap-2.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-4 py-2.5 text-xs font-medium text-[var(--text-primary)] shadow-lg"
    >
      <WifiOff className="w-4 h-4 text-[var(--state-warning)] shrink-0" />
      <span>
        Connection lost — Voice recordings and drafts are preserved locally. Cloud transcription & AI cleanup resume when back online.
      </span>
    </div>
  );
};
