import { useEffect, useRef } from 'react';
import type { WatchlistEntry } from '../../shared/index.ts';

export interface UndoToastProps {
  entry: WatchlistEntry | null;
  onUndo: (entry: WatchlistEntry) => void;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 7000;

export function UndoToast({ entry, onUndo, onDismiss }: UndoToastProps) {
  const toastRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);

  const clearDismissTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const startDismissTimer = () => {
    clearDismissTimer();
    if (!entry || pausedRef.current) {
      return;
    }
    timerRef.current = setTimeout(() => {
      onDismiss();
    }, AUTO_DISMISS_MS);
  };

  useEffect(() => {
    const toast = toastRef.current;
    if (!toast) {
      return;
    }

    if (entry && !document.querySelector('dialog[open]')) {
      try {
        const el = toast as HTMLDivElement & { showPopover?: () => void };
        if (typeof el.showPopover === 'function' && !toast.matches(':popover-open')) {
          el.showPopover();
        }
      } catch {
        // Fallback to .toast-visible CSS class in environments without native Popover API
      }
      startDismissTimer();
    } else {
      clearDismissTimer();
      try {
        const el = toast as HTMLDivElement & { hidePopover?: () => void };
        if (typeof el.hidePopover === 'function' && toast.matches(':popover-open')) {
          el.hidePopover();
        }
      } catch {
        // Ignore popover hide errors
      }
    }

    return () => {
      clearDismissTimer();
    };
  }, [entry]);

  const announcement = entry ? `Removed "${entry.title}" from Watchlist.` : '';

  return (
    <>
      <div id="sr-live-region" className="visually-hidden" aria-live="polite">
        {announcement}
      </div>

      <div role="region" aria-label="Notifications" className="toast-stack">
        <div
          ref={toastRef}
          id="undo-toast"
          popover="manual"
          role={entry ? 'status' : undefined}
          hidden={!entry}
          className={`toast-item ${entry ? 'toast-visible' : ''}`}
          tabIndex={-1}
          onPointerEnter={() => {
            pausedRef.current = true;
            clearDismissTimer();
          }}
          onPointerLeave={() => {
            pausedRef.current = false;
            startDismissTimer();
          }}
          onFocus={() => {
            pausedRef.current = true;
            clearDismissTimer();
          }}
          onBlur={() => {
            if (!toastRef.current?.contains(document.activeElement)) {
              pausedRef.current = false;
              startDismissTimer();
            }
          }}
        >
          {entry && (
            <>
              <span className="text-xs font-medium text-slate-900">
                Removed &ldquo;{entry.title}&rdquo; from Watchlist
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onUndo(entry)}
                  className="rounded border border-blue-600 bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 cursor-pointer"
                >
                  Undo
                </button>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={onDismiss}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  ×
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
