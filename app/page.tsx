import Dashboard from '@/components/Dashboard';
import { PROVIDER_KEYS, configuredMapWithMagpie } from '@/lib/providers';

// The configured/unconfigured split reads env vars and credential files, so it
// must be computed per request — never baked into a build-time prerender.
export const dynamic = 'force-dynamic';

export default async function Home() {
  // Server-side initial value so the first paint already hides what has no key
  // (no flash of cards that then disappear). Refreshes re-read it via /api/config.
  const configured = await configuredMapWithMagpie();
  return <Dashboard providers={PROVIDER_KEYS} initialConfigured={configured} />;
}
