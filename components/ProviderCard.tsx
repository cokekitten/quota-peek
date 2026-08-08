'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProviderKey, ProviderResponse, ProviderResult, UsageLimit } from './types';

interface Props {
  provider: ProviderKey;
  /** Increments when Dashboard requests a refresh; card refetches on change. */
  refreshKey: number;
}

// Slots per provider. Most providers report 5h + Weekly windows.
// Codex and SuperGrok only have a single weekly window now.
// Volcengine additionally reports a monthly window.
const getSlots = (provider: ProviderKey) => {
  if (provider === 'supergrok' || provider === 'codex') {
    return [{ kind: 'weekly', label: 'Weekly' }] as const;
  }
  if (provider === 'volcengine') {
    return [
      { kind: '5h', label: '5h Window' },
      { kind: 'weekly', label: 'Weekly' },
      { kind: 'monthly', label: 'Monthly' },
    ] as const;
  }
  return [
    { kind: '5h', label: '5h Window' },
    { kind: 'weekly', label: 'Weekly' },
  ] as const;
};

type State =
  // First load only — no data yet. We render the provider's configured slots (at 0%).
  | { status: 'loading' }
  // Have data. `refreshing` is true while a background refetch is in flight;
  // the old data stays visible and is swapped in place.
  | { status: 'ready'; data: ProviderResult; at: string; refreshing: boolean }
  // Initial fetch failed with no data to fall back on.
  | { status: 'error'; message: string };

export default function ProviderCard({ provider, refreshKey }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  /** Selected account tab: 0 = merged view, 1..n = per-account. */
  const [acct, setAcct] = useState(0);
  // Track the in-flight request so a slow response can't overwrite a newer one.
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, refreshing: true } : { status: 'loading' },
    );

    fetch(`/api/usage/${provider}`)
      .then(async (r) => {
        const json = (await r.json()) as ProviderResponse | { ok: false; error?: string };
        if (!r.ok || !('provider' in json)) {
          throw new Error((json as { error?: string }).error || `HTTP ${r.status}`);
        }
        if (id !== reqId.current) return; // stale
        setState({ status: 'ready', data: json.provider, at: json.timestamp, refreshing: false });
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return; // stale
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) =>
          prev.status === 'ready' ? { ...prev, refreshing: false } : { status: 'error', message },
        );
      });
  }, [provider, refreshKey]);

  const label = LABELS[provider];

  // Genuine error with no prior data → offline card.
  if (state.status === 'error') {
    return (
      <div className="card error">
        <div className="card-head">
          <span className="label">{label}</span>
          <span className="tag">offline</span>
        </div>
        <div className="text-note">{state.message}</div>
      </div>
    );
  }

  // API answered but the provider itself failed → offline card with its error.
  if (state.status === 'ready' && !state.data.ok) {
    return (
      <div className="card error">
        <div className="card-head">
          <span className="label">{label}</span>
          <span className="tag">offline</span>
        </div>
        <div className="text-note">{state.data.error || 'unknown error'}</div>
      </div>
    );
  }

  const loading = state.status === 'loading';
  const refreshing = state.status === 'ready' && state.refreshing;
  const busy = loading || refreshing;
  const summary = state.status === 'ready' ? state.data.summary : undefined;
  // Multi-account is fully data-driven: any provider whose summary carries an
  // accounts list gets the Σ/1/2 toggle — no per-provider special-casing.
  const accounts = summary?.accounts;
  const multi = !!accounts && accounts.length > 1;
  // Clamp the selection if a refresh shrank the account list.
  const sel = multi && acct >= 1 && acct <= accounts.length ? acct : 0;
  const accountView = multi && sel > 0 ? accounts[sel - 1] : null;
  const limits = accountView ? accountView.limits : summary?.limits ?? [];
  const planLabel = accountView ? accountView.planLabel : summary?.planLabel ?? undefined;
  const stale = state.status === 'ready' && !!state.data.stale;
  const partial = multi && !!summary?.partial;

  return (
    <div className={`card${loading ? ' loading' : ''}`}>
      <div className="card-head">
        <span className="label">{label}</span>
        {multi && (
          <span className="seg" role="tablist" aria-label="Account">
            <button
              className={sel === 0 ? 'on' : ''}
              onClick={() => setAcct(0)}
              title="Merged across accounts"
            >
              Σ
            </button>
            {accounts.map((a, i) => (
              <button
                key={a.key}
                className={sel === i + 1 ? 'on' : ''}
                onClick={() => setAcct(i + 1)}
                title={
                  a.ok
                    ? `Account ${a.key}${a.planLabel ? ` · ${a.planLabel}` : ''}`
                    : `Account ${a.key}: ${a.error || 'offline'}`
                }
              >
                {a.key}
                {!a.ok && '!'}
              </button>
            ))}
          </span>
        )}
        <span className="head-right">
          {busy && <span className="spinner" title={loading ? 'loading' : 'refreshing'} />}
          <span className={stale ? 'tag stale' : 'tag'}>
            {loading
              ? '—'
              : stale
                ? 'cached'
                : multi && !accountView
                  ? `×${accounts.length}${partial ? ' ⚠' : ''}`
                  : planLabel || 'live'}
          </span>
        </span>
      </div>
      {accountView && !accountView.ok ? (
        <div className="text-note">{accountView.error || 'offline'}</div>
      ) : (
        getSlots(provider).map((slot) => {
          // Match by kind; a window missing from the response renders at 0%.
          const limit = limits.find((l) => l.kind === slot.kind);
          return <Metric key={slot.kind} label={slot.label} limit={limit} dim={busy} />;
        })
      )}
    </div>
  );
}

function Metric({
  label,
  limit,
  dim,
}: {
  label: string;
  limit?: UsageLimit;
  dim?: boolean;
}) {
  const p = limit ? Math.max(0, Math.min(100, limit.percent)) : 0;
  const sev = p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok';
  const reset = limit?.resetAt ? `Resets in ${fmtRel(limit.resetAt)}` : null;
  // Merged rows carry a quota-weighted expectedPercent (windows reset at
  // different times); single accounts derive expected from their own reset.
  const pace = limit
    ? limit.expectedPercent !== undefined
      ? paceFromExpected(p, limit.expectedPercent)
      : limit.resetAt
        ? paceDelta(limit.kind, p, limit.resetAt)
        : null
    : null;

  return (
    <div className="metric">
      <div className="k">
        <span>{label}</span>
        <span className="v">
          {limit?.estimated && (
            <span className="est" title="Estimated — accounts report percentages only, merged as a mean">
              ≈
            </span>
          )}
          {p}%
          {pace && (
            <span className={`pace ${pace.cls}`} title={pace.title}>
              {pace.text}
            </span>
          )}
        </span>
      </div>
      <div className="bar">
        <span className={sev} style={{ width: `${p}%`, opacity: dim ? 0.4 : 1 }} />
      </div>
      {reset && (
        <div className="meta">
          <span className="reset" title={limit!.resetAt}>
            {reset}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Pace delta: compares actual consumption against even (time-proportional)
 * consumption. Window length is implied by kind (5h / 7d); with the reset time
 * we know how much of the window has elapsed, hence the "expected" percent.
 * Positive delta = burning faster than pace (over), negative = under pace.
 */
function paceDelta(
  kind: string,
  percent: number,
  resetAt: string,
): { text: string; cls: 'over' | 'under' | 'even'; title: string } | null {
  const duration =
    kind === '5h'
      ? 5 * 3600e3
      : kind === 'weekly'
        ? 7 * 24 * 3600e3
        : kind === 'monthly'
          ? 30 * 24 * 3600e3 // billing-cycle anchored; start unknown → 30d estimate
          : null;
  if (!duration) return null;
  const remainMs = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(remainMs)) return null;
  const expected = Math.min(100, Math.max(0, (1 - remainMs / duration) * 100));
  return paceFromExpected(percent, expected);
}

/** Delta of actual vs expected consumption: positive = burning faster. */
function paceFromExpected(
  percent: number,
  expected: number,
): { text: string; cls: 'over' | 'under' | 'even'; title: string } {
  const delta = Math.round(percent - expected);
  const expectedRound = Math.round(expected);
  if (delta === 0) {
    return { text: '±0%', cls: 'even', title: `On pace — ${expectedRound}% expected by elapsed time` };
  }
  const cls = delta > 10 ? 'over' : delta < -10 ? 'under' : 'even';
  return {
    text: `${delta > 0 ? '+' : ''}${delta}%`,
    cls,
    title: `${delta > 0 ? 'Ahead of' : 'Behind'} pace — ${expectedRound}% expected by elapsed time`,
  };
}

function fmtRel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  if (ms < 60_000) return '<1 min';
  const totalMin = Math.floor(ms / 60_000);
  const min = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const hr = totalHr % 24;
  const days = Math.floor(totalHr / 24);
  if (days > 0) return `${days} d ${hr} hr`;
  if (totalHr > 0) return min > 0 ? `${totalHr} hr ${min} min` : `${totalHr} hr`;
  return `${min} min`;
}

const LABELS: Record<ProviderKey, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  glm: 'GLM',
  supergrok: 'SuperGrok',
  minimax: 'MiniMax',
  kimi: 'Kimi',
  volcengine: 'Volcengine',
};
