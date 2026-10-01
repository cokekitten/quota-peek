import { NextResponse } from 'next/server';
import { PROVIDER_KEYS } from '@/lib/providers';
import type { ProviderResponse } from '@/lib/providers';
import type { ProviderKey } from '@/lib/providers/types';
import { ensurePoller } from '@/lib/history/poller';
import { serveUsage } from '@/lib/history/serve';

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

  // A page visit also guarantees the poller is running even if the boot
  // handoff never landed.
  ensurePoller();

  // Served from the sampler's last reading when that reading is young enough
  // (see lib/history/serve.ts) — opening the dashboard does not re-call every
  // provider, which is half of why the rate-limited ones go offline. A served
  // read is not written to history again; the sampler already recorded it.
  const served = await serveUsage(provider as ProviderKey);
  const body: ProviderResponse = {
    ok: true,
    timestamp: new Date(served.at).toISOString(),
    provider: served.result,
  };
  return NextResponse.json(body);
}
