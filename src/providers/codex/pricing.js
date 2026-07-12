"use strict";

// $ per million tokens, from https://developers.openai.com/api/docs/pricing.
// cachedInput is an absolute rate (not a multiplier). The -pro models have no
// cached-input discount, so their cachedInput equals the input rate.
const PRICING = [
  { match: /^gpt-5\.5-pro/, input: 30, cachedInput: 30, output: 180 },
  { match: /^gpt-5\.5/, input: 5, cachedInput: 0.5, output: 30 },
  { match: /^gpt-5\.4-mini/, input: 0.75, cachedInput: 0.075, output: 4.5 },
  { match: /^gpt-5\.4-nano/, input: 0.2, cachedInput: 0.02, output: 1.25 },
  { match: /^gpt-5\.4-pro/, input: 30, cachedInput: 30, output: 180 },
  { match: /^gpt-5\.4/, input: 2.5, cachedInput: 0.25, output: 15 },
  { match: /^gpt-5-mini/, input: 0.25, cachedInput: 0.025, output: 2 },
  { match: /^gpt-5-nano/, input: 0.05, cachedInput: 0.005, output: 0.4 },
  // gpt-5, gpt-5.1 and their -codex variants (no longer on the pricing page,
  // last published rates)
  { match: /^gpt-5/, input: 1.25, cachedInput: 0.125, output: 10 },
];

function findRate(model) {
  if (!model) return null;
  const hit = PRICING.find((p) => p.match.test(model));
  return hit || null;
}

/**
 * usage: Codex token_count shape — { input_tokens, cached_input_tokens,
 * output_tokens }. input_tokens INCLUDES the cached portion.
 * Returns { costUsd: number|null, rateKnown: boolean }
 */
function costForUsage(model, usage) {
  const rate = findRate(model);
  if (!rate || !usage) return { costUsd: null, rateKnown: false };

  const input = usage.input_tokens || 0;
  const cached = Math.min(usage.cached_input_tokens || 0, input);
  const output = usage.output_tokens || 0;

  const cost =
    ((input - cached) * rate.input) / 1e6 +
    (cached * rate.cachedInput) / 1e6 +
    (output * rate.output) / 1e6;

  return { costUsd: cost, rateKnown: true };
}

module.exports = { costForUsage, findRate };
