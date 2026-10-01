import { NextResponse } from 'next/server';
import { PROVIDER_KEYS } from '@/lib/providers';
import type { ProviderKey } from '@/lib/providers/types';
import { parseRange } from '@/lib/history/series';
import { csvRowsInRange } from '@/lib/history/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const COLUMNS = [
  'ts',
  'ts_iso',
  'source',
  'scope',
  'kind',
  'label',
  'percent',
  'used',
  'total',
  'unit',
  'reset_at',
  'sample_ok',
  'err_kind',
  'plan_label',
  'partial',
  'stale',
] as const;

/** RFC 4180: quote when the value contains a quote, comma, CR or LF. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Raw recorded rows as CSV — every sample, no downsampling, so the numbers can
 * be re-aggregated outside the app.
 *
 *   GET /api/history/claude/export?range=30d
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!PROVIDER_KEYS.includes(provider as ProviderKey)) {
    return NextResponse.json(
      { ok: false, error: `Unknown provider. Valid: ${PROVIDER_KEYS.join(', ')}` },
      { status: 404 },
    );
  }
  const url = new URL(request.url);
  const to = Date.now();
  const from = to - parseRange(url.searchParams.get('range') ?? '30d');
  const rows = csvRowsInRange(provider, from, to);
  const lines = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.ts,
        new Date(r.ts).toISOString(),
        r.source,
        r.scope,
        r.kind,
        r.label,
        r.percent === null ? '' : Math.round(r.percent * 100) / 100,
        r.used,
        r.total,
        r.unit,
        r.resetAt === null ? '' : new Date(r.resetAt).toISOString(),
        r.ok ? 1 : 0,
        r.errKind,
        r.planLabel,
        r.partial ? 1 : 0,
        r.stale ? 1 : 0,
      ]
        .map(cell)
        .join(','),
    );
  }
  const body = lines.join('\n') + '\n';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="quota-peek-${provider}-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
