import { NextResponse } from 'next/server';
import { PROVIDER_KEYS } from '@/lib/providers';
import type { ProviderResponse } from '@/lib/providers';
import type { ProviderKey } from '@/lib/providers/types';
import { extractSample } from '@/lib/history/extract';
import { ensurePoller } from '@/lib/history/poller';
import { liveUsage } from '@/lib/history/liveCache';
import { record } from '@/lib/history/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Precompute the allowed-key matcher so Next can generate it at build time.
export const dynamicParams = true;

export function generateStaticParams() {
  return PROVIDER_KEYS.map((provider) => ({ provider }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!PROVIDER_KEYS.includes(provider as ProviderKey)) {
    return NextResponse.json(
      { ok: false, error: `Unknown provider. Valid: ${PROVIDER_KEYS.join(', ')}` },
      { status: 404 },
    );
  }

  // liveUsage collapses a page load with an overlapping poll round onto one
  // upstream request (60s reuse), which matters for the rate-limited providers.
  // A page visit also guarantees the poller is running even if the boot
  // handoff never landed.
  ensurePoller();
  const data = await liveUsage(provider as ProviderKey);
  const body: ProviderResponse = {
    ok: true,
    timestamp: new Date().toISOString(),
    provider: data,
  };
  // Every fetch is a sample: this is the "what did the refresh see" record.
  // record() never throws — a broken history store must not fail the card.
  const sample = extractSample(data, 'page');
  record(sample, sample.ts);
  return NextResponse.json(body);
}
