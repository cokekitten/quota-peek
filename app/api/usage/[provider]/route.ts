import { NextResponse } from 'next/server';
import { fetchOneUsage, PROVIDER_KEYS } from '@/lib/providers';
import type { ProviderResponse } from '@/lib/providers';
import type { ProviderKey } from '@/lib/providers/types';

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

  const data = await fetchOneUsage(provider as ProviderKey);
  const body: ProviderResponse = {
    ok: true,
    timestamp: new Date().toISOString(),
    provider: data,
  };
  return NextResponse.json(body);
}
