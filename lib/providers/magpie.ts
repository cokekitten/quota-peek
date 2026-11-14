import type { ProviderKey, ProviderResult, UsageLimit } from './types';
import { fetchMultiAccount } from './accounts';

/**
 * magpie (yetone/magpie) as a source of provider quota.
 *
 * The user keeps the real accounts in magpie — signed-in subscriptions and
 * plan keys — and magpie already knows how to read each vendor:
 *
 *   GET <MAGPIE_BASE_URL>/v1/magpie/quotas
 *     Authorization: Bearer <MAGPIE_GATEWAY_KEY>
 *     → { object: "list", data: [
 *         { provider: "devin", name: "Devin", plan?: "Ultra", user: "a@b · org",
 *           kind: "subscription" | "plan" | "balance",
 *           windows: [{ name: "7 days", used: 4, resetsAt: "…",
 *                       pool?: "Gemini", display?: "$0.00", text?: true }],
 *           until?, readAt? }, … ] }
 *
 * `used` is a percentage. Windows are pooled where magpie pools them (an
 * Antigravity card reports "Gemini · 5 hours" and "Claude & GPT · 5 hours"
 * instead of one row per model), so this module maps them onto the card kinds
 * the dashboard already knows:
 *
 *   antigravity → gemini   Gemini pool → 5h / weekly
 *                          other pool  → 3p_5h / 3p_weekly
 *   devin       → devin    "7 days" → weekly, "1 day" → daily
 *   cursor      → cursor   Weekly → weekly, Grok Bot → grok-bot
 *   claude/codex/grok/kimi-code/minimax-code-global/qwen-token-plan → native cards
 *
 * A card in magpie means a card here: when magpie has an account for a
 * provider, that provider's quota comes from magpie (MAGPIE_PREFER=0 flips
 * this to "only when this machine has no credentials of its own"). Local
 * credentials stay the source for everything magpie doesn't carry, and a
 * provider magpie answers with an error keeps its red offline card instead of
 * silently falling back — the point of the dashboard is to see the breakage.
 *
 * Text-only windows (magpie's "On-demand $0.00" style rows, `text: true` with
 * no percentage) and pay-as-you-go balance cards are left out: a bar over a
 * money pool that no quota divides says nothing.
 */

const TIMEOUT_MS = Number(process.env.MAGPIE_TIMEOUT_MS || 20000);
const CACHE_TTL_MS = Number(process.env.MAGPIE_CACHE_TTL_MS || 60000);
const QUOTAS_PATH = '/v1/magpie/quotas';

export interface MagpieWindow {
  name?: string;
  /** Percent used (0–100), as magpie reports it. */
  used?: number;
  remaining?: number;
  resetsAt?: string;
  /** Verbatim row text for windows magpie renders as text (money, info). */
  display?: string;
  /** True when magpie shows this row as text, not a bar. */
  text?: boolean;
  /** What the window is pooled under, e.g. "Gemini" / "Claude & GPT". */
  pool?: string;
}

export interface MagpieCard {
  provider?: string;
  name?: string;
  plan?: string;
  user?: string;
  kind?: string;
  windows?: MagpieWindow[];
  until?: string;
  readAt?: string;
}

/** The magpie providers that stand for a dashboard card. */
const CARD_PROVIDERS: Record<string, ProviderKey> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  devin: 'devin',
  antigravity: 'gemini',
  // Subscription plans magpie files under the vendor's own id.
  grok: 'supergrok',
  'kimi-code': 'kimi',
  'kimi-code-cn': 'kimi',
  'minimax-code-global': 'minimax',
  'qwen-token-plan': 'qwen',
  zhipu: 'glm',
  zai: 'glm',
  xiaomi: 'mimo',
  stepfun: 'stepfun',
  'stepfun-cn': 'stepfun',
  volcengine: 'volcengine',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  qwen: 'qwen',
  'qwen-cn': 'qwen',
};

/** magpie provider id → the card it feeds; undefined for anything else. */
export function magpieProviderFor(card: MagpieCard): ProviderKey | undefined {
  return card.provider ? CARD_PROVIDERS[card.provider] : undefined;
}

/** Base URL + gateway key must both be set for magpie to be a source. */
export function magpieConfigured(): boolean {
  return Boolean(process.env.MAGPIE_BASE_URL && magpieKey());
}

function magpieKey(): string | undefined {
  return process.env.MAGPIE_GATEWAY_KEY || process.env.MAGPIE_API_KEY || undefined;
}

function magpieBase(): string {
  return (process.env.MAGPIE_BASE_URL || '').replace(/\/+$/, '');
}

function pct1(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** A slug safe to use as a window kind (unique per card row). */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'window'
  );
}

/** Canonical kind + label for a magpie window name. */
export function windowKind(
  card: MagpieCard,
  w: MagpieWindow,
): { kind: string; label: string } | undefined {
  const name = (w.name || '').trim();
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const hours5 = /\b5\s*(h|hours?)\b/.test(lower);
  const weekly = /\b7\s*(d|days?)\b/.test(lower) || /^weekly\b/.test(lower);
  // Antigravity pools: the Gemini half is this card's own quota, everything
  // else (Claude, GPT) is the 3P half — the same split the native provider
  // shows as 5h/weekly + 3P Models.
  if (card.provider === 'antigravity' && w.pool) {
    const own = w.pool.toLowerCase() === 'gemini';
    if (hours5) return own ? { kind: '5h', label: '5h Window' } : { kind: '3p_5h', label: '3P Models · 5h' };
    if (weekly) return own ? { kind: 'weekly', label: 'Weekly' } : { kind: '3p_weekly', label: '3P Models · Weekly' };
    return { kind: slug(`${w.pool}-${name}`), label: `${w.pool} · ${name}` };
  }
  if (hours5) return { kind: '5h', label: '5h Window' };
  if (weekly) return { kind: 'weekly', label: 'Weekly' };
  if (/^(1|24)\s*(day|days|h|hour|hours)\b/.test(lower)) {
    return { kind: 'daily', label: 'Daily' };
  }
  if (/^daily\b/.test(lower)) return { kind: 'daily', label: 'Daily' };
  if (/month/.test(lower)) return { kind: 'monthly', label: 'Monthly' };
  return { kind: slug(name), label: name };
}

/** One card's windows as dashboard limits. Text-only and unknown rows drop. */
export function cardLimits(card: MagpieCard): UsageLimit[] {
  const out: UsageLimit[] = [];
  for (const w of card.windows ?? []) {
    // Text rows carry no percentage (magpie draws them as plain text); a bar
    // would read as "0% used", which is a different claim.
    if (w.text) continue;
    const kind = windowKind(card, w);
    if (!kind) continue;
    const used = typeof w.used === 'number' && Number.isFinite(w.used) ? w.used : undefined;
    if (used === undefined) continue;
    const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    out.push({
      label: kind.label,
      kind: kind.kind,
      percent: pct1(used),
      ...(Number.isFinite(resetMs) ? { resetAt: new Date(resetMs).toISOString() } : {}),
    });
  }
  return out;
}

/** The dashboard sees one card per provider; magpie may hold several accounts. */
function cardsFor(cards: MagpieCard[], key: ProviderKey): MagpieCard[] {
  return cards.filter(
    (c) =>
      magpieProviderFor(c) === key &&
      // A pay-as-you-go wallet is not a plan quota; its card belongs to the
      // vendor's own dashboard, not to a window card here.
      c.kind !== 'balance' &&
      cardLimits(c).length > 0,
  );
}

/** Which providers magpie can serve right now. */
export type MagpieCoverage = Partial<Record<ProviderKey, boolean>>;

let cache: { at: number; cards: MagpieCard[] } | null = null;
let lastGood: MagpieCard[] | null = null;
let pending: Promise<MagpieCard[]> | null = null;

/** For tests: forget everything this module cached. */
export function resetMagpieCacheForTests(): void {
  cache = null;
  lastGood = null;
  pending = null;
}

/** For tests: keep the last good read but force the next call upstream. */
export function expireMagpieCacheForTests(): void {
  cache = null;
}

async function readQuotas(): Promise<MagpieCard[]> {
  const key = magpieKey();
  if (!key) throw new Error('MAGPIE_GATEWAY_KEY is not set');
  const url = `${magpieBase()}${QUOTAS_PATH}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    let detail = '';
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail =
        (typeof body.error === 'object' ? body.error?.message : body.error) || body.message || '';
    } catch {
      // not JSON; the status is all we have
    }
    throw new Error(`magpie answered HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
  let payload: { data?: MagpieCard[] };
  try {
    payload = JSON.parse(text || '{}') as { data?: MagpieCard[] };
  } catch {
    throw new Error('magpie answered /v1/magpie/quotas with a body that is not JSON');
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

/** magpie's quota list, deduped for CACHE_TTL_MS; throws when unreachable. */
export async function magpieCards(): Promise<MagpieCard[]> {
  if (!magpieConfigured()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cards;
  if (pending) return pending;
  pending = readQuotas()
    .then((cards) => {
      cache = { at: Date.now(), cards };
      lastGood = cards;
      return cards;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * Providers magpie can serve. Answers from the last good read when magpie is
 * unreachable, so a provider that *was* magpie-backed stays visible (and goes
 * offline) instead of silently turning into "no key".
 */
export async function magpieCoverage(): Promise<MagpieCoverage> {
  if (!magpieConfigured()) return {};
  let cards: MagpieCard[];
  try {
    cards = await magpieCards();
  } catch {
    cards = lastGood ?? [];
  }
  const out: MagpieCoverage = {};
  for (const card of cards) {
    const key = magpieProviderFor(card);
    if (key && cardsFor(cards, key).length) out[key] = true;
  }
  return out;
}

/** True when the provider card should take its numbers from magpie. */
export async function magpieServes(key: ProviderKey): Promise<boolean> {
  const coverage = await magpieCoverage();
  return coverage[key] === true;
}

/**
 * This provider's card, read from magpie. Undefined when magpie doesn't carry
 * it (nothing changes for that provider) — a magpie failure for a provider it
 * does carry is returned as a normal offline result.
 */
export async function magpieProviderResult(
  key: ProviderKey,
): Promise<ProviderResult | undefined> {
  if (!magpieConfigured()) return undefined;
  const covered = await magpieServes(key);
  if (!covered) return undefined;

  let cards: MagpieCard[];
  try {
    cards = await magpieCards();
  } catch (err) {
    return {
      ok: false,
      provider: key,
      label: 'magpie',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const mine = cardsFor(cards, key);
  if (!mine.length) return undefined;

  const label = mine[0]?.name || key;
  const results = await fetchMultiAccount(
    mine.map((card, i) => ({ key: String(i + 1), config: card })),
    async (card) => cardResult(key, card),
    { provider: key, label },
  );
  return results;
}

async function cardResult(key: ProviderKey, card: MagpieCard): Promise<ProviderResult> {
  const limits = cardLimits(card);
  if (!limits.length) {
    return {
      ok: false,
      provider: key,
      label: card.name || key,
      error: 'magpie returned this account with no quota windows',
    };
  }
  return {
    ok: true,
    provider: key,
    label: card.name || key,
    summary: {
      planLabel: card.plan || undefined,
      planKey: card.plan || undefined,
      limits,
    },
  };
}

/** Hint appended to a "no key" card, pointing at the other source. */
export function magpieHint(): string {
  return 'or add the account in magpie and set MAGPIE_BASE_URL + MAGPIE_GATEWAY_KEY';
}
