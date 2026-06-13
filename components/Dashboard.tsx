'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ProviderCard from './ProviderCard';
import type { ProviderKey } from './types';

interface Props {
  providers: ProviderKey[];
}

const AUTO_INTERVAL = 10 * 60 * 1000; // 10 minutes

export default function Dashboard({ providers }: Props) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [auto, setAuto] = useState(false);
  const autoTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
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

  return (
    <>
      <header className="header">
        <div className="brand">
          <h1>Quota Peek</h1>
          <span className="sub">AI coding plan usage</span>
        </div>
        <div className="controls">
          <label className="auto">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Auto (10m)
          </label>
          <button onClick={refresh}>Refresh</button>
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
          GET <code>/api/usage/[provider]</code> · 3 parallel requests, each card renders
          as soon as its provider responds
        </span>
      </footer>
    </>
  );
}
