'use client';

import { useEffect, useRef, useState } from 'react';
import type { HistoryDelta, HistorySeries } from '@/lib/history/series';
import {
  PROVIDER_LABELS,
  type AccountUsage,
  type ProviderKey,
  type ProviderResponse,
  type ProviderResult,
  type UsageLimit,
} from './types';

interface Props {
  provider: ProviderKey;
  /** Increments when Dashboard requests a refresh; card refetches on change. */
  refreshKey: number;
  /** Sparkline series for this provider, from the dashboard's history request. */
  series?: HistorySeries[];
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
  // StepFun plans come in two shapes (rolling 5h/weekly windows *or* a monthly
  // credit pool) that the response only reveals per account, so this card is
  // fully data-driven — the provider names every row it returns. DeepSeek
  // (money card: one 消费金额/充值余额 row, or a bare Balance), MiMo
  // (comp/monthly credits + money row) and OpenRouter (Month Spend + Key
  // Limit) name their rows too.
  if (
    provider === 'stepfun' ||
    provider === 'deepseek' ||
    provider === 'mimo' ||
    provider === 'openrouter' ||
    provider === 'qwen' ||
    provider === 'cursor' ||
    provider === 'devin'
  ) {
    return [] as const;
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

export default function ProviderCard({ provider, refreshKey, series }: Props) {
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

  const label = PROVIDER_LABELS[provider];

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

  // API answered but the provider itself failed. No key at all renders as a
  // neutral dashed card (the header toggle is what surfaces these); a real
  // failure keeps the red offline card with its error.
  if (state.status === 'ready' && !state.data.ok) {
    const unc = state.data.notConfigured;
    return (
      <div className={`card error${unc ? ' unconfigured' : ''}`}>
        <div className="card-head">
          <span className="label">{label}</span>
          <span className="tag">{unc ? 'no key' : 'offline'}</span>
        </div>
        <div className="text-note">
          {unc ? 'Not configured — ' : ''}
          {state.data.error || 'unknown error'}
        </div>
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
  // The merged view can look healthy while nothing is servable: Σ averages
  // each account's leftover quota, so #1's maxed 5h window + #2's maxed
  // weekly window still draw two comfortable-looking bars. `unavailable` is
  // the provider's verdict that every account is out on some window.
  const unavailable = multi && !accountView && !!summary?.unavailable;
  // History follows the account tab: the Σ view charts the merged row, the
  // per-account tabs chart that account's own row.
  const scope = accountView ? accountView.key : 'merged';
  const findSeries = (kind: string) => series?.find((s) => s.scope === scope && s.kind === kind);

  return (
    <div className={`card${loading ? ' loading' : ''}`}>
      <div className="card-head">
        <span className="head-left">
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
                  className={[sel === i + 1 ? 'on' : '', a.ok && a.exhausted?.length ? 'maxed' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => setAcct(i + 1)}
                  title={
                    a.ok
                      ? `Account ${a.key}${a.planLabel ? ` · ${a.planLabel}` : ''}${
                          a.exhausted?.length ? ` — ${a.exhausted.join(' + ')} maxed` : ''
                        }`
                      : `Account ${a.key}: ${a.error || 'offline'}`
                  }
                >
                  {a.key}
                  {!a.ok && '!'}
                </button>
              ))}
            </span>
          )}
        </span>
        <span className="head-right">
          {busy && <span className="spinner" title={loading ? 'loading' : 'refreshing'} />}
          <span className={`tag${stale ? ' stale' : ''}${unavailable ? ' crit' : ''}`}>
            {loading
              ? '—'
              : stale
                ? 'cached'
                : multi && !accountView
                  ? `×${accounts.length}${unavailable ? ' · maxed' : ''}${partial ? ' ⚠' : ''}`
                  : planLabel || 'live'}
          </span>
        </span>
      </div>
      {unavailable && accounts && (
        <div
          className="card-alert"
          title="Every account has at least one window at 100%, so no account can serve a request — the merged bars average in capacity that cannot be spent."
        >
          {unavailableNote(accounts)}
        </div>
      )}
      {accountView && !accountView.ok ? (
        <div className="text-note">{accountView.error || 'offline'}</div>
      ) : (
        getSlots(provider).map((slot) => {
          // Match by kind; a window missing from the response renders at 0%.
          const limit = limits.find((l) => l.kind === slot.kind);
          return (
            <Metric
              key={slot.kind}
              label={slot.label}
              limit={limit}
              dim={busy}
              series={findSeries(slot.kind)}
            />
          );
        })
      )}
      {/* Windows beyond the static slots (e.g. Claude's model-scoped Fable
          quota) render dynamically — new kinds appear with no slot changes. */}
      {!(accountView && !accountView.ok) &&
        limits
          .filter((l) => !getSlots(provider).some((s) => s.kind === l.kind))
          .map((l) => (
            <Metric key={l.kind} label={l.label} limit={l} dim={busy} series={findSeries(l.kind)} />
          ))}
    </div>
  );
}

/**
 * One line naming every account's maxed window, when no account can serve.
 * Null while at least one account still has headroom (or none answered) —
 * an unservable card is the only thing this sentence claims.
 */
export function unavailableNote(accounts: AccountUsage[]): string | null {
  const serving = accounts.filter((a) => a.ok);
  if (!serving.length || !serving.every((a) => !!a.exhausted?.length)) return null;
  return `No account can serve — ${serving
    .map((a) => `#${a.key} ${a.exhausted!.join(' + ')} maxed`)
    .join(' · ')}`;
}

export function Metric({
  label,
  limit,
  dim,
  series,
}: {
  label: string;
  limit?: UsageLimit;
  dim?: boolean;
  /** Recorded readings for this exact row (scope + kind), if the store has any. */
  series?: HistorySeries;
}) {
  // Grade a money delta against the row's own current figure; a percentage
  // delta is already in the same unit as the number beside it.
  const current = limit?.kind === 'balance' ? limit.used : limit?.percent;
  const badge = deltaBadge(series?.delta, undefined, current);
  // Money rows (Balance) are an amount, not a window: state the figure once,
  // with no bar, percent or pace — a progress bar over a money pool means
  // nothing. A window rollover (e.g. OpenRouter's Month Spend) still shows
  // as a plain countdown.
  if (limit?.kind === 'balance') {
    return (
      <div className="metric">
        <div className="k">
          <span>{label}</span>
          <span className="v">
            {limit.used !== undefined ? fmtAbs(limit.used, limit.unit) : '—'}
            {badge && (
              <span className={`delta ${badge.cls}`} title={badge.title}>
                {badge.text}
              </span>
            )}
          </span>
        </div>
        {(limit.detail || limit.resetAt) && (
          <div className="meta">
            {limit.detail && <span className="detail">{limit.detail}</span>}
            {limit.resetAt && (
              <span className="reset" title={limit.resetAt}>
                Resets in {fmtRel(limit.resetAt)}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
  const p = limit ? Math.max(0, limit.percent) : 0;
  const barPct = Math.min(100, p); // bar width caps at the quota; the number stays true
  const sev = p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok';
  const reset = limit?.resetAt ? `Resets in ${fmtRel(limit.resetAt)}` : null;
  // Absolute numbers (money pools, credit counts) — percent-only rows skip this.
  // Money rows spell the two figures out (spent · left) because the bar above
  // is NOT their ratio: a "¥1,312.62 / ¥1,366.93" pair next to "49.0%" reads
  // like a broken used/total.
  const abs =
    limit && limit.used !== undefined
      ? limit.kind === 'spend' && limit.total !== undefined
        ? `${fmtAbs(limit.used, limit.unit)} spent · ${fmtAbs(limit.total, limit.unit)} left`
        : `${fmtAbs(limit.used, limit.unit)}${
            limit.total !== undefined ? ` / ${fmtAbs(limit.total, limit.unit)}` : ''
          }`
      : null;
  // Merged rows carry a quota-weighted expectedPercent (windows reset at
  // different times); single accounts derive expected from their own window.
  const expected = limit ? expectedPercentFor(limit, Date.now()) : null;
  const pace = limit && expected !== null ? paceFromExpected(p, expected) : null;
  // Money rows: name both figures in the tooltip, including the pool the bar
  // actually divides by (month spend + remaining balance = month-start money).
  const absTitle =
    limit && limit.kind === 'spend' && limit.used !== undefined
      ? limit.total !== undefined
        ? `当月消费 ${fmtAbs(limit.used, limit.unit)} · 月初余额 ${fmtAbs(
            limit.used + limit.total,
            limit.unit,
          )} (= 消费 + 剩余); bar = 当月消费 ÷ 月初余额`
        : `当月消费 ${fmtAbs(limit.used, limit.unit)} · 余额未知; bar = 消费占比`
      : 'used / total';

  return (
    <div className="metric">
      <div className="k">
        <span>{label}</span>
        <span className="v">
          {p}%
          {pace && (
            <span className={`pace ${pace.cls}`} title={pace.title}>
              {pace.text}
            </span>
          )}
          {badge && (
            <span className={`delta ${badge.cls}`} title={badge.title}>
              {badge.text}
            </span>
          )}
        </span>
      </div>
      <div className="bar">
        <span className={sev} style={{ width: `${barPct}%`, opacity: dim ? 0.4 : 1 }} />
      </div>
      {(abs || limit?.detail || reset) && (
        <div className="meta">
          {abs && (
            <span className="abs" title={absTitle}>
              {abs}
            </span>
          )}
          {limit?.detail && <span className="detail">{limit.detail}</span>}
          {reset && (
            <span className="reset" title={limit!.resetAt}>
              {reset}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Expected consumption by elapsed time — the yardstick the pace badge measures
 * against. Three sources, in order of trust:
 *
 *   1. `expectedPercent` — merged rows already weighted it at fetch time.
 *   2. `paceStartAt` + `resetAt` — the provider knows both ends of the window,
 *      so elapsed/whole is exact (a 31-day month is not 30).
 *   3. the kind's estimated duration — no window start available at all
 *      (billing cycles: Cursor's on-demand, MiMo's plan period).
 */
export function expectedPercentFor(
  limit: Pick<UsageLimit, 'kind' | 'resetAt' | 'paceStartAt' | 'expectedPercent'>,
  nowMs: number,
): number | null {
  if (limit.expectedPercent !== undefined) return limit.expectedPercent;
  if (!limit.resetAt) return null;
  const resetMs = new Date(limit.resetAt).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const startMs = limit.paceStartAt ? new Date(limit.paceStartAt).getTime() : NaN;
  if (Number.isFinite(startMs) && resetMs > startMs) {
    return clamp01to100(((nowMs - startMs) / (resetMs - startMs)) * 100);
  }
  const duration = estimatedWindowMs(limit.kind);
  if (!duration) return null;
  return clamp01to100((1 - (resetMs - nowMs) / duration) * 100);
}

const clamp01to100 = (v: number): number => Math.min(100, Math.max(0, v));

/** Window length implied by kind when the provider doesn't state one. */
function estimatedWindowMs(kind: string): number | null {
  if (kind === '5h' || kind === 'session') return 5 * 3600e3;
  if (kind === 'daily') return 24 * 3600e3;
  if (kind === 'weekly' || kind.startsWith('weekly_')) return 7 * 24 * 3600e3;
  // Month-anchored, start unknown → 30d estimate; rows without a reset time
  // and without `paceStartAt` get no pace badge at all.
  if (kind === 'monthly' || kind === 'spend') return 30 * 24 * 3600e3;
  return null;
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

/**
 * Change since the previous reading, rendered next to the current number.
 *
 * A window rollover returns no delta at all (a reset is not a drop), so the
 * badge says so instead of inventing a -98%.
 */
/**
 * Magnitude bands for the change badge.
 *
 * Colouring by *direction* (anything up = red) turned a normal 5-minute poll
 * into a wall of red: at this sampling interval almost every reading moves by
 * ±1pp. Worse, the pace badge right next to it already uses red/amber/green
 * for a different question (speed vs elapsed time), so two adjacent pills in
 * the same three colours meant two different things.
 *
 * So the badge is graded by magnitude — it is a signal, not decoration — and
 * the pace badge keeps the colours.
 */
const PP_NEUTRAL = 2;
const PP_WARN = 10;
/** Money rows have no fixed scale, so grade them relative to the row itself. */
const MONEY_NEUTRAL_RATIO = 0.01;
const MONEY_WARN_RATIO = 0.05;

function magnitude(mag: number, warn: number, crit: number): 'even' | 'warn' | 'crit' {
  if (mag >= crit) return 'crit';
  if (mag >= warn) return 'warn';
  return 'even';
}

export function deltaBadge(
  delta: HistoryDelta | null | undefined,
  now: number = Date.now(),
  /** Current value of the row, so a money delta can be judged relatively. */
  current?: number | null,
): { text: string; cls: 'even' | 'warn' | 'crit'; title: string } | null {
  if (!delta) return null;
  if (delta.kind === 'reset') {
    return { text: '↻ reset', cls: 'even', title: 'Window rolled over — usage since reset, no change to compare' };
  }
  const when = `since ${fmtAgo(now - delta.at)}`;
  const v = delta.value;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const mag = Math.abs(v);
  if (delta.kind === 'pp') {
    const one = Math.round(mag * 10) / 10;
    return {
      text: mag < 0.05 ? '±0%' : `${sign}${one.toFixed(1)}%`,
      cls: magnitude(one, PP_NEUTRAL, PP_WARN),
      // A big drop that no window reset explains is worth saying out loud:
      // the reading changed for a reason the timeline does not carry.
      title: `${one.toFixed(1)} percentage points ${when}${
        delta.suspect === 'stable-reset'
          ? ' · no window reset, so this is a quota-basis or upstream correction, not consumption'
          : delta.suspect === 'no-reset-info'
            ? ' · this row reports no reset time, so a window reset cannot be ruled out'
            : ''
      }`,
    };
  }
  const amount = fmtAbs(mag, delta.unit ?? undefined);
  // No row value to compare against (a balance we only see the delta of):
  // fall back to the same absolute bands, in money units.
  const base = current && current > 0 ? Math.abs(current) : null;
  const cls = base
    ? magnitude(mag / base, MONEY_NEUTRAL_RATIO, MONEY_WARN_RATIO)
    : mag >= 100
      ? 'crit'
      : mag >= 10
        ? 'warn'
        : 'even';
  return {
    text: mag < 0.005 ? '±0' : `${sign}${amount}`,
    cls,
    title: base
      ? `${amount} ${when} (${((mag / base) * 100).toFixed(2)}% of ${fmtAbs(base, delta.unit ?? undefined)})`
      : `${amount} ${when}`,
  };
}

/** Compact "time since" label: 45s / 12 min / 3 h / 2 d 4 h. */
function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h`;
  return `${Math.floor(hr / 24)} d ${hr % 24} h`;
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

/** Absolute used/total numbers: money with a currency prefix, big counts compact. */
function fmtAbs(n: number, unit?: string): string {
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (unit === '¥' || unit === '$') {
    const abs = Math.abs(n);
    const s = abs >= 1000 ? n.toFixed(0) : abs >= 1 ? String(Math.round(n * 100) / 100) : n.toFixed(2);
    return `${unit}${s}`;
  }
  const suffix = unit ? ` ${unit}` : '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B${suffix}`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M${suffix}`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K${suffix}`;
  return `${trim(n)}${suffix}`;
}

