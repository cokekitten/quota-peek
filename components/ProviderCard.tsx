'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProviderKey, ProviderResponse, ProviderResult } from './types';

interface Props {
  provider: ProviderKey;
  /** Increments when Dashboard requests a refresh; card refetches on change. */
  refreshKey: number;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ProviderResult; at: string };

export default function ProviderCard({ provider, refreshKey }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  // Track the in-flight request so a slow response can't overwrite a newer one.
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setState({ status: 'loading' });

    fetch(`/api/usage/${provider}`)
      .then(async (r) => {
        const json = (await r.json()) as ProviderResponse | { ok: false; error?: string };
        if (!r.ok || !('provider' in json)) {
          throw new Error((json as { error?: string }).error || `HTTP ${r.status}`);
        }
        if (id !== reqId.current) return; // stale
        setState({ status: 'ready', data: json.provider, at: json.timestamp });
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return; // stale
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [provider, refreshKey]);

  return <div className={`card ${state.status}`}>{renderBody(provider, state)}</div>;
}

function renderBody(provider: ProviderKey, state: State) {
  const label = LABELS[provider];

  if (state.status === 'loading') {
    return (
      <>
        <div className="card-head">
          <span className="label">{label}</span>
          <span className="tag">
            <span className="spinner" />
            loading
          </span>
        </div>
        <div className="text-note">Fetching…</div>
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <>
        <div className="card-head">
          <span className="label">{label}</span>
          <span className="tag">offline</span>
        </div>
        <div className="text-note">{state.message}</div>
      </>
    );
  }

  const { data, at } = state;
  const limits = data.summary?.limits ?? [];
  const planLabel = data.summary?.planLabel;

  return (
    <>
      <div className="card-head">
        <span className="label">{label}</span>
        <span className="head-right">
          <span className="updated">{new Date(at).toLocaleTimeString()}</span>
          <span className={data.stale ? 'tag stale' : 'tag'}>
            {data.stale ? 'cached' : planLabel || 'live'}
          </span>
        </span>
      </div>
      {limits.map((l, i) => (
        <Metric key={`${l.kind}-${i}`} limit={l} />
      ))}
    </>
  );
}

function Metric({ limit }: { limit: NonNullable<ProviderResult['summary']>['limits'][number] }) {
  const p = Math.max(0, Math.min(100, limit.percent));
  const color = p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--yellow)' : 'var(--green)';
  const reset = limit.resetAt ? `Resets in ${fmtRel(limit.resetAt)}` : null;

  return (
    <div className="metric">
      <div className="k">
        <span>{limit.label}</span>
        <span className="v">{p}%</span>
      </div>
      <div className="bar">
        <span style={{ width: `${p}%`, background: color }} />
      </div>
      {reset && (
        <div className="meta">
          <span className="reset" title={limit.resetAt}>
            {reset}
          </span>
        </div>
      )}
    </div>
  );
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
};;
