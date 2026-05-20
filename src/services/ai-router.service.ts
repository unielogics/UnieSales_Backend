import { env } from '../config/env';
import type { AiActionType } from '../db/schema/ai-actions';

export type ModelTier = 'light' | 'heavy';

/**
 * Route AI action types to Haiku (light) vs Sonnet (heavy) per the spec.
 * Light: fast/cheap classifications, simple generation.
 * Heavy: training critique, playbook/demo-guide generation, complex reasoning.
 */
export function pickModelTier(action: AiActionType): ModelTier {
  switch (action) {
    // Heavy reasoning required
    case 'generate_playbook':
    case 'generate_demo_guide':
      return 'heavy';

    // Everything else uses the light model
    default:
      return 'light';
  }
}

export function pickModel(action: AiActionType): string {
  const e = env();
  return pickModelTier(action) === 'heavy' ? e.ANTHROPIC_MODEL_HEAVY : e.ANTHROPIC_MODEL_LIGHT;
}

/**
 * Override hook for cases the spec calls out as "use heavy even for normally-light"
 * (e.g. pricing/legal replies, angry replies, high-value leads, ambiguous classifications).
 * Callers can pass `forceHeavy` to ai.service.runAction.
 */
export function modelFor(action: AiActionType, forceHeavy = false): string {
  if (forceHeavy) return env().ANTHROPIC_MODEL_HEAVY;
  return pickModel(action);
}
