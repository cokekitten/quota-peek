import { NextResponse } from 'next/server';
import { configuredMap } from '@/lib/providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Which providers currently have credentials (env var or credential file
 * present). Local checks only — no upstream calls, so it is cheap enough to
 * poll on every refresh. The dashboard uses it to hide cards that have no key
 * (header toggle shows them again).
 */
export async function GET() {
  return NextResponse.json({
    timestamp: new Date().toISOString(),
    configured: configuredMap(),
  });
}
