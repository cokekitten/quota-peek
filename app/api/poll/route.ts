import { NextResponse } from 'next/server';
import { POLL_ENABLED, isPolling, lastPoll, pollIfIdle, startPoller, type PollSummary } from '@/lib/history/poller';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Trimmed poll state for the wire — provider keys and outcomes, never data. */
function summary(s: PollSummary | null) {
  if (!s) return null;
  return {
    at: s.at,
    tookMs: s.tookMs,
    pruned: s.pruned,
    providers: s.providers.map((p) => ({
      provider: p.provider,
      ok: p.ok,
      errKind: p.errKind,
      rows: p.rows,
      ...(p.skipped ? { skipped: p.skipped } : {}),
      ...(p.storeError ? { storeError: p.storeError } : {}),
    })),
  };
}

function isLoopback(request: Request): boolean {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
  const host = ip || '127.0.0.1';
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1' || host === 'localhost';
}

/**
 * Poller control. GET is the boot handoff target: it starts the poller (once)
 * and reports state. POST runs a round right now — loopback only, so this
 * can't be used to hammer a provider's API from the outside.
 */
export async function GET() {
  if (!POLL_ENABLED) {
    return NextResponse.json({ ok: true, enabled: false });
  }
  startPoller();
  return NextResponse.json({ ok: true, enabled: true, polling: isPolling(), last: summary(lastPoll()) });
}

export async function POST(request: Request) {
  if (!POLL_ENABLED) return NextResponse.json({ ok: true, enabled: false });
  if (!isLoopback(request)) {
    return NextResponse.json({ ok: false, error: 'loopback only' }, { status: 403 });
  }
  const ran = await pollIfIdle();
  return NextResponse.json({
    ok: true,
    enabled: true,
    ran: !!ran,
    last: summary(ran ?? lastPoll()),
  });
}
