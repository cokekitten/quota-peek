'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ProviderCard from './ProviderCard';
import type { ProviderKey } from './types';

interface Props {
  providers: ProviderKey[];
}

const AUTO_INTERVAL = 10 * 60 * 1000; // 10 minutes
const REFOCUS_THRESHOLD = 3 * 60 * 1000; // refresh on tab refocus after 3 min

export default function Dashboard({ providers }: Props) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [auto, setAuto] = useState(false);
  const [theme, setTheme] = useState<'a' | 'c'>('a');
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
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
    } catch {
      /* storage unavailable — keep default */
    }
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

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    lastRefreshAt.current = Date.now();
    setUpdatedAt(new Date());
  }, []);

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

  return (
    <>
      <header className="header">
        <div className="brand">
          <span className="logo">Q</span>
          <h1>Quota Peek</h1>
          <span className="sub">AI coding plan usage</span>
        </div>
        <div className="controls">
          <span className="pill">
            <span className="dot" />
            {providers.length}
            <span className="pill-word">&nbsp;providers</span> ·{' '}
            {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
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
        <div className="grid">
          {providers.map((p) => (
            <ProviderCard key={p} provider={p} refreshKey={refreshKey} />
          ))}
        </div>
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
