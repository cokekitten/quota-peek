import { describe, expect, it } from 'vitest';
import { PROVIDER_KEYS } from './types';

describe('PROVIDER_KEYS', () => {
  // The dashboard renders cards in exactly this order — it is the specified
  // layout, not an implementation detail. Reordering here reshuffles every
  // user's board.
  it('keeps the card layout order', () => {
    expect(PROVIDER_KEYS).toEqual([
      'claude',
      'kimi',
      'codex',
      'deepseek',
      'mimo',
      'glm',
      'stepfun',
      'supergrok',
      'minimax',
      'openrouter',
      'volcengine',
    ]);
  });
});
