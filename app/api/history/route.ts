import { NextResponse } from 'next/server';
import { buildDashboardHistory, parseRange } from '@/lib/history/series';
import { sampleCount } from '@/lib/history/store';
import { intParam } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';


/**
 * Short-window history for the dashboard's per-card sparklines: one request
 * for every channel, merged scope only (per-account curves live on /history).
 *
 *   GET /api/history?range=6h&max=40
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get('range') ?? '6h');
  const max = intParam(url.searchParams.get('max'), 40, 2, 400);
  const to = Date.now();
  const from = to - range;
  try {
    const body = buildDashboardHistory(from, to, max);
    return NextResponse.json({ ...body, samples: sampleCount() });
  } catch (err) {
    // History is a side channel: a failure here degrades the sparklines, and
    // the cards keep rendering live usage.
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
