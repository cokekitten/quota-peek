/**
 * Server boot hook.
 *
 * Next compiles this file into BOTH the node and the edge bundle, and the edge
 * bundle cannot resolve `node:` builtins or native addons. So this file stays
 * deliberately import-free: the poller lives in the node layer (SQLite +
 * providers), and the only thing that happens here is handing off to it over
 * loopback once the server is listening.
 *
 * The route handlers also call ensurePoller() on demand, so a failed handoff
 * only costs "polling starts on the first request", never a broken server.
 */

const HANDOFF_PATH = '/api/poll';
const HANDOFF_ATTEMPTS = 20;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.QP_POLL === '0') return;
  if (process.env.NODE_ENV === 'test') return;
  void handoff();
}

async function handoff(): Promise<void> {
  const port = process.env.PORT || '5928';
  const base = (process.env.QP_SELF_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  // register() runs before the server listens, so retry until it answers.
  for (let attempt = 1; attempt <= HANDOFF_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${base}${HANDOFF_PATH}`, { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 2000)));
  }
  console.warn(`[quota-peek] poller handoff failed after ${HANDOFF_ATTEMPTS} tries — set QP_SELF_URL if the port is mapped`);
}
