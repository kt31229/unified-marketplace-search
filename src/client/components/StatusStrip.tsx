import { useEffect, useRef, useState } from 'react';
import {
  MARKETPLACE_IDS,
  MARKETPLACE_LABELS,
  type BrowserMarketplaceId,
  type MarketplaceId,
  type MarketplaceStatus,
} from '../../shared/index.ts';

function isBrowserMarketplace(mp: MarketplaceId): mp is BrowserMarketplaceId {
  return mp === 'poshmark' || mp === 'mercari' || mp === 'facebook';
}

function supportsHintPopover(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  try {
    const probe = document.createElement('div');
    if (!('popover' in probe)) {
      return false;
    }
    probe.setAttribute('popover', 'hint');
    return probe.popover === 'hint';
  } catch {
    return false;
  }
}

function supportsAnchorPositioning(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('position-area', 'block-end')
  );
}

function formatStatusBadge(status: MarketplaceStatus): {
  label: string;
  toneClass: string;
} {
  switch (status.runStatus) {
    case 'running':
      return {
        label:
          status.completedCities != null && status.totalCities
            ? `City ${status.completedCities} of ${status.totalCities}`
            : 'Running...',
        toneClass: 'status-badge-neutral',
      };
    case 'skipped_unsupported':
      return { label: 'Skipped (unsupported)', toneClass: 'status-badge-skip' };
    case 'unconfigured':
      return { label: 'Unconfigured', toneClass: 'status-badge-warn' };
    case 'challenge_or_auth_required':
      return { label: 'Challenge', toneClass: 'status-badge-danger' };
    case 'timeout':
      return { label: 'Timeout', toneClass: 'status-badge-danger' };
    case 'parse_error':
      return { label: 'Parse error', toneClass: 'status-badge-danger' };
    case 'network_error':
      return { label: 'Network error', toneClass: 'status-badge-danger' };
    case 'success':
    case 'empty':
      if (status.stoppedByUser) {
        return { label: 'Stopped', toneClass: 'status-badge-warn' };
      }
      if (status.translationStatus === 'broadened') {
        return { label: 'Broadened', toneClass: 'status-badge-warn' };
      }
      return { label: 'Exact', toneClass: 'status-badge-success' };
  }
}

interface StatusCardProps {
  marketplace: MarketplaceId;
  status: MarketplaceStatus | undefined;
  isRetrying: boolean;
  isStoppingFacebook?: boolean;
  onRetry: (marketplace: MarketplaceId) => void;
  onStopFacebook?: () => void;
  onOpenBrowserSession: (marketplace: BrowserMarketplaceId, url?: string) => void;
}

function StatusCard({
  marketplace,
  status,
  isRetrying,
  isStoppingFacebook,
  onRetry,
  onStopFacebook,
  onOpenBrowserSession,
}: StatusCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [clickOpen, setClickOpen] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);

  const tooltipOpen = hoverOpen || focusOpen || clickOpen || nativeOpen;

  const hintSupported = supportsHintPopover();
  const nativePopoverSupported =
    typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

  const syncFallbackPosition = () => {
    const card = cardRef.current;
    const tip = tipRef.current;
    if (!card || !tip) {
      return;
    }
    const rect = card.getBoundingClientRect();
    if (rect.width > 0) {
      tip.style.width = `${rect.width}px`;
    }
    if (!supportsAnchorPositioning()) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipAbove = spaceBelow < 110 && rect.top > 110;
      tip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
      if (flipAbove) {
        tip.style.top = 'auto';
        tip.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
      } else {
        tip.style.bottom = 'auto';
        tip.style.top = `${rect.bottom + 6}px`;
      }
    }
  };

  const showNativePopover = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    syncFallbackPosition();
    const tip = tipRef.current;
    if (tip && nativePopoverSupported && typeof tip.showPopover === 'function') {
      try {
        if (!tip.matches(':popover-open')) {
          tip.showPopover();
        }
      } catch {
        // Ignore popover state errors in constrained environments
      }
    }
  };

  const hideNativePopover = () => {
    const tip = tipRef.current;
    if (tip && nativePopoverSupported && typeof tip.hidePopover === 'function') {
      try {
        if (tip.matches(':popover-open')) {
          tip.hidePopover();
        }
      } catch {
        // Ignore popover state errors
      }
    }
  };

  const closeAll = () => {
    setHoverOpen(false);
    setFocusOpen(false);
    setClickOpen(false);
    setNativeOpen(false);
    hideNativePopover();
  };

  const scheduleHoverClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      setHoverOpen(false);
      if (!focusOpen && !clickOpen) {
        hideNativePopover();
      }
    }, 120);
  };

  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) {
      return;
    }
    const onToggle = (event: Event) => {
      const toggleEvt = event as ToggleEvent;
      const isOpen = toggleEvt.newState === 'open';
      if (isOpen) {
        syncFallbackPosition();
      }
      setNativeOpen(isOpen);
      if (!isOpen) {
        setHoverOpen(false);
        setFocusOpen(false);
        setClickOpen(false);
      }
    };
    tip.addEventListener('toggle', onToggle);
    return () => {
      tip.removeEventListener('toggle', onToggle);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!tooltipOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAll();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tooltipOpen]);

  const label = MARKETPLACE_LABELS[marketplace];
  const tipId = `status-tip-${marketplace}`;

  if (!status) {
    return (
      <div
        ref={cardRef}
        data-testid={`status-card-${marketplace}`}
        data-status-card={marketplace}
        className="status-card"
        style={{ anchorName: `--status-card-${marketplace}` } as React.CSSProperties}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`mp-badge mp-badge-${marketplace}`}>{label}</span>
          <span className="status-badge status-badge-skip">Not queried</span>
        </div>
        <div className="text-xs text-slate-500">Not included in this search run.</div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            disabled={isRetrying}
            onClick={() => onRetry(marketplace)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
          >
            Retry {label}
          </button>
        </div>
      </div>
    );
  }

  const badge = formatStatusBadge(status);
  const diagnosticLines: string[] = [...status.notices];
  if (status.stoppedByUser) {
    diagnosticLines.push('Facebook sweep stopped early; earlier Listings retained.');
  }
  if (status.droppedMalformedCount > 0) {
    diagnosticLines.push(`Skipped ${status.droppedMalformedCount} malformed node(s).`);
  }
  if (status.errorMessage) {
    diagnosticLines.push(status.errorMessage);
  }
  if (diagnosticLines.length === 0) {
    diagnosticLines.push('All active Unified Filters translated cleanly.');
  }

  const interestProps = {
    interestfor: tipId,
  } as Record<string, string>;

  return (
    <div
      ref={cardRef}
      data-testid={`status-card-${marketplace}`}
      data-status-card={marketplace}
      className="status-card"
      style={{ anchorName: `--status-card-${marketplace}` } as React.CSSProperties}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className={`mp-badge mp-badge-${marketplace}`}>{label}</span>
          {marketplace === 'facebook' && status.runStatus === 'running' && (
            <button
              type="button"
              className="fb-sweep-stop-btn"
              aria-label="Stop Facebook sweep"
              title="Stop Facebook sweep"
              disabled={isStoppingFacebook}
              onClick={onStopFacebook}
            >
              <span className="fb-spinner-icon" aria-hidden="true" />
              <span className="fb-stop-icon" aria-hidden="true">
                ×
              </span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`status-badge ${badge.toneClass}`}>{badge.label}</span>
          <button
            ref={triggerRef}
            type="button"
            className="status-info-btn"
            aria-label={`${label} status details`}
            aria-expanded={tooltipOpen}
            aria-controls={tipId}
            popoverTarget={tipId}
            popoverTargetAction="show"
            {...interestProps}
            onClick={() => {
              if (clickOpen) {
                closeAll();
              } else {
                setClickOpen(true);
                showNativePopover();
              }
            }}
            onPointerEnter={() => {
              setHoverOpen(true);
              showNativePopover();
            }}
            onPointerLeave={scheduleHoverClose}
            onFocus={() => {
              setFocusOpen(true);
              showNativePopover();
            }}
            onBlur={() => {
              setFocusOpen(false);
              if (!hoverOpen && !clickOpen) {
                hideNativePopover();
              }
            }}
          >
            i
          </button>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2 text-xs text-slate-600">
        <span className="tabular font-medium text-slate-800">
          {status.loadedCount} {status.loadedCount === 1 ? 'Listing' : 'Listings'}
        </span>
        {status.currentCityLabel && (
          <span className="truncate text-slate-500">{status.currentCityLabel}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <a
          href={status.nativeSearchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 no-underline hover:bg-slate-50"
        >
          Open on {label} ↗
        </a>
        <button
          type="button"
          disabled={isRetrying || status.runStatus === 'running'}
          onClick={() => onRetry(marketplace)}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
        >
          Retry {label}
        </button>
        {isBrowserMarketplace(marketplace) && (
          <button
            type="button"
            onClick={() => onOpenBrowserSession(marketplace, status.nativeSearchUrl)}
            className={
              status.runStatus === 'challenge_or_auth_required'
                ? 'rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-100 cursor-pointer'
                : 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer'
            }
          >
            Open browser session
          </button>
        )}
      </div>

      <div
        ref={tipRef}
        id={tipId}
        role="tooltip"
        popover={hintSupported ? 'hint' : 'auto'}
        hidden={!tooltipOpen}
        className={`status-diag status-tooltip ${tooltipOpen ? 'tooltip-open' : ''}`}
        style={{ positionAnchor: `--status-card-${marketplace}` } as React.CSSProperties}
        onPointerEnter={() => {
          if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
          }
          setHoverOpen(true);
        }}
        onPointerLeave={scheduleHoverClose}
      >
        <div className="mb-1 font-semibold text-slate-900">{label} diagnostics</div>
        <ul className="m-0 list-disc pl-4 text-xs text-slate-700">
          {diagnosticLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export interface StatusStripProps {
  statuses: Partial<Record<MarketplaceId, MarketplaceStatus>>;
  retryingMarketplace: MarketplaceId | null;
  isStoppingFacebook?: boolean;
  onRetry: (marketplace: MarketplaceId) => void;
  onStopFacebook?: () => void;
  onOpenBrowserSession: (marketplace: BrowserMarketplaceId, url?: string) => void;
}

export function StatusStrip({
  statuses,
  retryingMarketplace,
  isStoppingFacebook,
  onRetry,
  onStopFacebook,
  onOpenBrowserSession,
}: StatusStripProps) {
  return (
    <section className="status-strip" aria-label="Marketplace status">
      {MARKETPLACE_IDS.map((mp) => (
        <StatusCard
          key={mp}
          marketplace={mp}
          status={statuses[mp]}
          isRetrying={retryingMarketplace === mp}
          isStoppingFacebook={mp === 'facebook' ? isStoppingFacebook : false}
          onRetry={onRetry}
          onStopFacebook={mp === 'facebook' ? onStopFacebook : undefined}
          onOpenBrowserSession={onOpenBrowserSession}
        />
      ))}
    </section>
  );
}
