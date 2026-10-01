/** Small helpers shared by the API routes. */

/**
 * Parse a positive integer query param, clamped.
 *
 * `Number(null)` is 0, which silently reads as "off" for something like the
 * refresh log (`Number(null) ?? 200` → 0), so an absent or unparsable value
 * has to fall back to the default explicitly.
 */
export function intParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
