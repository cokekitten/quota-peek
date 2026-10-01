'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ProviderCard from './ProviderCard';
import type { HistorySeries } from '@/lib/history/series';
import type { ConfiguredMap, ProviderKey } from './types';

interface Props {
  providers: ProviderKey[];
  /** Which providers have credentials; computed server-side per page load. */
  initialConfigured: ConfiguredMap;
}

const AUTO_INTERVAL = 10 * 60 * 1000; // 10 minutes
const REFOCUS_THRESHOLD = 3 * 60 * 1000; // refresh on tab refocus after 3 min
const SHOW_UNCONFIGURED_KEY = 'qp-show-unconfigured';
// The cards only show a change badge, so the server sends just the two
// readings the delta is computed from (the delta itself is always taken from
// the raw rows, never from downsampled points). The window is still 6h so a
// long-stalled poller reports "no change" instead of an invented one.
const HISTORY_RANGE = '6h';
const HISTORY_MAX_POINTS = 2;

export default function Dashboard({ providers, initialConfigured }: Props) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [auto, setAuto] = useState(false);
  const [theme, setTheme] = useState<'a' | 'c'>('a');
  // Providers with no key / no credential file are hidden by default. A card
  // that IS configured but failing (expired token, 429, network) never hides —
  // that would delete the very signal the dashboard exists to show.
  const [configured, setConfigured] = useState<ConfiguredMap>(initialConfigured);
  const [showUnconfigured, setShowUnconfigured] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  // Per-provider readings behind the change badge, fetched once for every
  // card. Best-effort: a failure leaves the cards exactly as they are.
  const [history, setHistory] = useState<Record<string, HistorySeries[]>>({});
  const autoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Timestamp of the last refresh trigger; used to decide whether a refocus
  // should fetch again (only if more than REFOCUS_THRESHOLD has passed).
  const lastRefreshAt = useRef<number>(Date.now());

  // Restore the saved theme on mount (layout.tsx sets the pre-paint default).
  useEffect(() => {
    try {
      const t = localStorage.getItem('qp-theme') === 'c' ? 'c' : 'a';
      setTheme(t);
      document.documentElement.dataset.theme = t;
      if (localStorage.getItem(SHOW_UNCONFIGURED_KEY) !== null) {
        setShowUnconfigured(localStorage.getItem(SHOW_UNCONFIGURED_KEY) === '1');
      }
    } catch {
      /* storage unavailable — keep default */
    }
  }, []);
  const toggleShowUnconfigured = useCallback(() => {
    setShowUnconfigured((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_UNCONFIGURED_KEY, next ? '1' : '0');
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'a' ? 'c' : 'a';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('qp-theme', next);
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, []);

  // Re-read the credential split: a `claude login` or a new .env key can show
  // up between refreshes without a page reload. Best-effort — on failure the
  // last known split stands.
  const probeConfigured = useCallback(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: { configured?: ConfiguredMap }) => {
        if (json?.configured && typeof json.configured === 'object') setConfigured(json.configured);
      })
      .catch(() => {
        /* keep the current split */
      });
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`/api/history?range=${HISTORY_RANGE}&max=${HISTORY_MAX_POINTS}`);
      if (!r.ok) return;
      const json = (await r.json()) as {
        ok?: boolean;
        providers?: Record<string, { series?: HistorySeries[] }>;
      };
      if (!json?.ok || !json.providers) return;
      // Unwrap {series: [...]} per provider and drop anything malformed — a
      // card with no history renders exactly as it did before.
      const next: Record<string, HistorySeries[]> = {};
      for (const [key, value] of Object.entries(json.providers)) {
        if (Array.isArray(value?.series)) next[key] = value.series;
      }
      setHistory(next);
    } catch {
      /* the change badge is decoration; live usage is the point */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    lastRefreshAt.current = Date.now();
    setUpdatedAt(new Date());
    probeConfigured();
  }, [probeConfigured]);

  useEffect(() => {
    if (auto) {
      autoTimer.current = setInterval(refresh, AUTO_INTERVAL);
    }
    return () => {
      if (autoTimer.current) {
        clearInterval(autoTimer.current);
        autoTimer.current = null;
      }
    };
  }, [auto, refresh]);

  // On tab refocus (visibility regained or window focused), refresh if it's
  // been more than REFOCUS_THRESHOLD since the last fetch — so stale data gets
  // refreshed when the user comes back, without hammering on every focus tick.
  useEffect(() => {
    const onRefocus = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastRefreshAt.current >= REFOCUS_THRESHOLD
      ) {
        refresh();
      }
    };
    document.addEventListener('visibilitychange', onRefocus);
    window.addEventListener('focus', onRefocus);
    return () => {
      document.removeEventListener('visibilitychange', onRefocus);
      window.removeEventListener('focus', onRefocus);
    };
  }, [refresh]);

  // Cards whose provider has no key are unmounted (not just hidden by CSS), so
  // they also don't fire their own fetches.
  const visible = showUnconfigured
    ? providers
    : providers.filter((p) => configured[p] !== false);
  const hidden = providers.length - visible.length;

  return (
    <>
      <header className="header">
        <div className="brand">
          <span className="logo">Q</span>
          <h1>Quota Peek</h1>
          <span className="sub">AI coding plan usage</span>
        </div>
        <div className="controls">
          <span
            className="pill"
            title={
              hidden
                ? `${visible.length} of ${providers.length} providers configured`
                : `${providers.length} providers`
            }
          >
            <span className="dot" />
            {visible.length}
            {hidden ? `/${providers.length}` : ''} ·{' '}
            {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {(hidden > 0 || showUnconfigured) && (
            <button
              className={`pill unc${showUnconfigured ? ' on' : ''}`}
              onClick={toggleShowUnconfigured}
              title={
                showUnconfigured
                  ? `${hidden} provider(s) without a key — shown. Click to hide.`
                  : `${hidden} provider(s) have no key / credentials — hidden. Click to show.`
              }
            >
              <span className="dot" />
              No key ×{hidden}
            </button>
          )}
          <button
            className={`pill auto${auto ? ' on' : ''}`}
            onClick={() => setAuto((a) => !a)}
            title={auto ? 'Auto-refresh on (10m) — click to turn off' : 'Auto-refresh off — click to turn on'}
          >
            <span className="dot" />
            Auto 10m
          </button>
          <button className="refresh" onClick={refresh}>
            Refresh
          </button>
          <a
            className="pill history-link"
            href="/history"
            title="Usage history — trend per window, and what every poll and refresh saw"
          >
            <span className="dot" />
            History
          </a>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === 'a' ? 'Switch to minimal theme' : 'Switch to aurora theme'}
            aria-label="Toggle theme"
          >
            {theme === 'a' ? '◐' : '◑'}
          </button>
        </div>
      </header>

      <main>
        {visible.length === 0 ? (
          <div className="empty">
            <p>
              No provider has credentials yet —{' '}
              <button className="link" onClick={toggleShowUnconfigured}>
                show them
              </button>{' '}
              to see which key each one needs.
            </p>
          </div>
        ) : (
          <div className="grid">
            {visible.map((p) => (
              <ProviderCard key={p} provider={p} refreshKey={refreshKey} series={history[p]} />
            ))}
          </div>
        )}
      </main>

      <footer>
        <span>
          GET <code>/api/usage/[provider]</code> · parallel requests, each card renders
          as soon as its provider responds
        </span>
      </footer>
    </>
  );
}
