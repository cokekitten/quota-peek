'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import TrendChart, { fmtChartValue } from '@/components/TrendChart';
import { deltaBadge } from '@/components/ProviderCard';
import type { HistoryLogEntry, HistorySeries } from '@/lib/history/series';
import { PROVIDER_LABELS, PROVIDER_ORDER, type ProviderKey } from '@/components/types';

interface HistoryResponse {
  ok: boolean;
  error?: string;
  provider?: string;
  from?: number;
  to?: number;
  series?: HistorySeries[];
  log?: HistoryLogEntry[];
  samples?: number;
  pollIntervalMs?: number;
}

const RANGES = [
  { key: '24h', label: '24h', ms: 24 * 3600e3 },
  { key: '7d', label: '7d', ms: 7 * 864e5 },
  { key: '30d', label: '30d', ms: 30 * 864e5 },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Big counters stay readable: 1.2B / 82B instead of 1240000000 / 82000000000. */
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (abs >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (abs >= 1e3) return `${Math.round(n / 100) / 10}K`;
  return String(Math.round(n * 100) / 100);
}

function fmtStamp(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `${sameDay ? '' : `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} `}${d.toLocaleTimeString(
    [],
    { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  )}`;
}

export default function HistoryPage() {
  const [provider, setProvider] = useState<ProviderKey>('claude');
  const [range, setRange] = useState<RangeKey>('7d');
  // Which view the charts show: 'merged' (Σ) or one account key. Fetching
  // always asks for every scope; the switch below is what the data says is
  // there, so a multi-account card never hides its accounts behind a checkbox.
  const [scope, setScope] = useState('merged');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/history/${provider}?range=${range}&scope=all`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as HistoryResponse;
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [provider, range]);

  useEffect(() => {
    void load();
  }, [load]);

  // This page exists to answer "what is happening right now" — a minute-old
  // answer is fine, a stale one is not. Only while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const all = data?.series ?? [];
  const log = data?.log ?? [];
  // Account keys this provider actually has, in numeric order.
  const accountKeys = useMemo(
    () =>
      [...new Set(all.filter((s) => s.scope !== 'merged').map((s) => s.scope))].sort((a, b) =>
        a.localeCompare(b, 'en', { numeric: true }),
      ),
    [all],
  );
  // A provider switch can leave the selection pointing at an account that
  // doesn't exist there; fall back to the merged view.
  useEffect(() => {
    if (scope !== 'merged' && !accountKeys.includes(scope)) setScope('merged');
  }, [accountKeys, scope]);
  const series = useMemo(
    () => (scope === 'merged' ? all.filter((s) => s.scope === 'merged') : all.filter((s) => s.scope === scope)),
    [all, scope],
  );
  const rangeMs = useMemo(() => RANGES.find((r) => r.key === range)?.ms ?? 7 * 864e5, [range]);

  // Adopt the URL once on mount, then keep it in sync — /history?provider=kimi
  // is a shareable link and survives a reload.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('provider') as ProviderKey | null;
    const r = params.get('range') as RangeKey | null;
    if (p && PROVIDER_ORDER.includes(p)) setProvider(p);
    if (r && RANGES.some((x) => x.key === r)) setRange(r);
    const sc = params.get('scope');
    if (sc) setScope(sc);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('provider', provider);
    url.searchParams.set('range', range);
    url.searchParams.set('scope', scope);
    window.history.replaceState(null, '', url.toString());
  }, [provider, range, scope]);

  return (
    <>
      <header className="header">
        <div className="brand">
          <a className="logo back" href="/" title="Back to the dashboard" aria-label="Back">
            ←
          </a>
          <h1>Usage History</h1>
          <span className="sub">
            every poll and refresh, on record
            {data?.pollIntervalMs ? ` · sampling every ${Math.round(data.pollIntervalMs / 60000)}m` : ''}
          </span>
        </div>
        <div className="controls">
          <span className="pill" title={`${data?.samples ?? 0} samples in range`}>
            <span className="dot" />
            {series.length} series · {log.length} reads
          </span>
          <button className="refresh" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
      </header>

      <div className="history-bar">
        <div className="seg wide" role="tablist" aria-label="Provider">
          {PROVIDER_ORDER.map((p) => (
            <button
              key={p}
              className={p === provider ? 'on' : ''}
              onClick={() => setProvider(p)}
              title={PROVIDER_LABELS[p]}
            >
              {PROVIDER_LABELS[p].split(' ')[0]}
            </button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.key} className={r.key === range ? 'on' : ''} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        {accountKeys.length > 1 && (
          <div className="seg" role="tablist" aria-label="Account">
            <button
              className={scope === 'merged' ? 'on' : ''}
              onClick={() => setScope('merged')}
              title="Merged across accounts"
            >
              Σ
            </button>
            {accountKeys.map((k) => (
              <button
                key={k}
                className={scope === k ? 'on' : ''}
                onClick={() => setScope(k)}
                title={`Account ${k}`}
              >
                {k}
              </button>
            ))}
          </div>
        )}
        <a className="pill csv" href={`/api/history/${provider}/export?range=${range}`} download>
          <span className="dot" />
          CSV
        </a>
      </div>

      <main className="history">
        {error && <div className="card error"><div className="text-note">{error}</div></div>}
        {!error && series.length === 0 && !loading && (
          <div className="empty">
            <p>
              Nothing recorded for {PROVIDER_LABELS[provider]}
              {scope !== 'merged' ? ` · account ${scope}` : ''} in the last {range}. The background
              sampler writes a sample every poll — check <code>/api/poll</code> if it never started.
            </p>
          </div>
        )}

        {series.map((s) => {
          const badge = deltaBadge(s.delta);
          return (
            <section className="card series" key={s.key}>
              <div className="card-head">
                <span className="head-left">
                  <span className="label">{s.label}</span>
                  {s.scope !== 'merged' && <span className="tag">account {s.scope}</span>}
                  {s.estimated && <span className="tag">est</span>}
                </span>
                <span className="head-right">
                  <span className="tag">
                    {s.last ? fmtChartValue(s.last.v, s.mode, s.unit) : '—'}
                    {s.last ? ` · ${fmtTime(s.last.at)}` : ''}
                  </span>
                  {badge && (
                    <span className={`delta ${badge.cls}`} title={badge.title}>
                      {badge.text}
                    </span>
                  )}
                  {s.stale && (
                    <span className="tag stale" title="Newest reading is older than a poll cycle">
                      stalled
                    </span>
                  )}
                </span>
              </div>
              <TrendChart series={s} from={data?.from ?? Date.now() - rangeMs} to={data?.to ?? Date.now()} />
              <div className="meta">
                <span>
                  {s.points.length} readings
                  {s.delta?.kind !== 'reset' && s.delta ? ` · ${badge?.text} since last` : ''}
                </span>
                {s.unit && <span>unit {s.unit}</span>}
                {s.last?.u != null && s.last?.n != null && (
                  <span className="abs">
                    {fmtCompact(s.last.u)} / {fmtCompact(s.last.n)}
                  </span>
                )}
              </div>
            </section>
          );
        })}

        {log.length > 0 && (
          <section className="card log">
            <div className="card-head">
              <span className="head-left">
                <span className="label">Refresh log</span>
              </span>
              <span className="head-right">
                <span className="tag">what each read saw</span>
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>time</th>
                  <th>source</th>
                  <th>readings</th>
                  <th>note</th>
                </tr>
              </thead>
              <tbody>
                {log.map((e) => (
                  <tr key={e.id} className={e.ok ? '' : 'bad'}>
                    <td className="mono">{fmtStamp(e.ts)}</td>
                    <td>
                      <span className={`tag ${e.source}`}>{e.source}</span>
                    </td>
                    <td>
                      {e.rows.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        e.rows.map((r) => (
                          <span className="chip" key={`${r.scope}-${r.kind}`} title={`${r.label} (${r.scope})`}>
                            {r.scope !== 'merged' ? `${r.scope}·` : ''}
                            {r.label}
                            <b>
                              {r.v !== null
                                ? fmtChartValue(r.v, r.kind === 'balance' || r.kind === 'spend' ? 'absolute' : 'percent', r.unit)
                                : '—'}
                            </b>
                          </span>
                        ))
                      )}
                    </td>
                    <td className="note">
                      {e.errKind === 'error'
                        ? e.errText
                        : e.errKind === 'not_configured'
                          ? 'not configured'
                          : e.stale
                            ? 'cached (live fetch failed)'
                            : e.partial
                              ? 'partial — some accounts failed'
                              : e.planLabel ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>

      <footer>
        <span>
          Samples come from <code>/api/poll</code> (background) and <code>/api/usage/*</code> (page
          loads). Nothing is uploaded anywhere.
        </span>
      </footer>
    </>
  );
}
