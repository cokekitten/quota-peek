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
        <span className={data.stale ? 'tag stale' : 'tag'}>
          {data.stale ? 'cached' : planLabel || 'live'}
        </span>
      </div>
      {limits.length === 0 && data.text && <div className="text-note">{data.text}</div>}
      {limits.map((l, i) => (
        <Metric key={`${l.kind}-${i}`} limit={l} />
      ))}
      {data.raw != null && (
        <details className="raw">
          <summary>raw response · {new Date(at).toLocaleTimeString()}</summary>
          <pre>{JSON.stringify(data.raw, null, 2)}</pre>
        </details>
      )}
    </>
  );
}

function Metric({ limit }: { limit: NonNullable<ProviderResult['summary']>['limits'][number] }) {
  const p = Math.max(0, Math.min(100, limit.percent));
  const color = p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--yellow)' : 'var(--green)';
  const usedTotal =
    typeof limit.used === 'number' && typeof limit.total === 'number'
      ? `${limit.used} / ${limit.total}`
      : null;
  const reset = limit.resetAt ? `resets ${fmtRel(limit.resetAt)}` : null;

  return (
    <div className="metric">
      <div className="k">
        <span>{limit.label}</span>
        <span className="v">{p}%</span>
      </div>
      <div className="bar">
        <span style={{ width: `${p}%`, background: color }} />
      </div>
      {(usedTotal || reset) && (
        <div className="meta">
          {usedTotal && <span>{usedTotal}</span>}
          {reset && (
            <span className="reset" title={limit.resetAt}>
              {reset}
            </span>
          )}
        </div>
      )}
      {limit.detail && <div className="detail">{limit.detail}</div>}
    </div>
  );
}

function fmtRel(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return '<1h';
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const LABELS: Record<ProviderKey, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  glm: 'GLM Coding Plan',
};
