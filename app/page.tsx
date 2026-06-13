import Dashboard from '@/components/Dashboard';
import { PROVIDER_KEYS } from '@/lib/providers';

export default function Home() {
  return <Dashboard providers={PROVIDER_KEYS} />;
}
