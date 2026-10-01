import { NextResponse } from 'next/server';
import { ensurePoller, isPolling, lastPoll, pollIfIdle, POLL_ENABLED } from '@/lib/history/poller';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Manual refresh: run one sampling round now, then let the cards read it.
 *
 * The dashboard's Refresh button points here instead of re-fetching every
 * provider itself — the round is the same work either way, but it is one
 * sequential pass instead of eleven parallel bursts, and it is recorded in the
 * refresh log as a real read.
 *
 * Not loopback-restricted (unlike POST /api/poll): loading the page already
 * triggered a full round of upstream calls before this existed, so this is not
 * a new capability — it is the explicit version of the same button.
 */
export async function POST() {
  ensurePoller();
  if (!POLL_ENABLED) {
    return NextResponse.json({ ok: true, enabled: false });
  }
  const ran = await pollIfIdle();
  if (ran) {
    // Same line the timer's rounds print, so "why did that take 4s?" is
    // answerable from `docker logs` alone.
    const bad = ran.providers.filter((x) => !x.ok).map((x) => x.provider);
    console.log(
      `[quota-peek] manual round ${ran.providers.length} provider(s) in ${ran.tookMs}ms` +
        (bad.length ? ` · failed: ${bad.join(', ')}` : ''),
    );
  }
  return NextResponse.json({
    ok: true,
    enabled: true,
    ran: !!ran,
    alreadyRunning: !ran && isPolling(),
    tookMs: ran?.tookMs ?? null,
    providers: ran?.providers.map((p) => ({
      provider: p.provider,
      ok: p.ok,
      errKind: p.errKind,
      rows: p.rows,
    })) ?? null,
    lastAt: ran?.at ?? lastPoll()?.at ?? null,
  });
}
