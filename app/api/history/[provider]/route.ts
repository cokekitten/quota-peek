import { NextResponse } from 'next/server';
import { PROVIDER_KEYS } from '@/lib/providers';
import type { ProviderKey } from '@/lib/providers/types';
import { buildProviderHistory, parseRange, pollIntervalMs } from '@/lib/history/series';
import { intParam } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function generateStaticParams() {
  return PROVIDER_KEYS.map((provider) => ({ provider }));
}

/**
 * One channel's full history: chart series plus the refresh log ("what every
 * poll and every manual refresh actually saw").
 *
 *   GET /api/history/claude?range=7d&scope=all&max=400&log=200
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
  const from = to - parseRange(url.searchParams.get('range') ?? '7d');
  const includeAccounts = url.searchParams.get('scope') === 'all';
  const maxPoints = intParam(url.searchParams.get('max'), 400, 20, 1000);
  const logLimit = intParam(url.searchParams.get('log'), 200, 0, 1000);
  try {
    const body = buildProviderHistory({
      provider,
      from,
      to,
      includeAccounts,
      maxPoints,
      logLimit,
      now: to,
    });
    return NextResponse.json({ ok: true, pollIntervalMs: pollIntervalMs(), ...body });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
