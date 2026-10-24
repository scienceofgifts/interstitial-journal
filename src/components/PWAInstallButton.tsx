import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3.5 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
        title="Install Interstitial as an app on your device"
      >
        <Download className="w-3.5 h-3.5 text-[var(--accent-sage)]" />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
        >
          <Smartphone className="w-3.5 h-3.5 text-[var(--accent-sage)]" />
          <span>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <h3 className="font-serif-editorial text-lg font-semibold text-[var(--text-primary)]">
                  Install on iPhone or iPad
                </h3>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] min-h-[40px] min-w-[40px] flex items-center justify-center"
                  aria-label="Close guide"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-[var(--text-secondary)] leading-relaxed list-decimal list-inside">
                <li>
                  Tap the <strong>Share</strong> icon in the Safari toolbar.
                </li>
                <li>
                  Scroll down and select <strong>Add to Home Screen</strong>.
                </li>
                <li>
                  Tap <strong>Add</strong> to launch Interstitial directly from your home screen.
                </li>
              </ol>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-[var(--accent-sage)] py-2.5 text-xs font-medium text-white hover:bg-[var(--accent-sage-hover)] transition-colors min-h-[44px]"
              >
                Got It
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
