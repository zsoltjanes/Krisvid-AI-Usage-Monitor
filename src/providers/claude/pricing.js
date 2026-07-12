"use strict";

// $ per million tokens. cacheWrite/cacheRead are multipliers of the input price.
const PRICING = [
  { match: /^claude-fable-5/, input: 10, output: 50 },
  { match: /^claude-mythos-5/, input: 10, output: 50 },
  { match: /^claude-opus-4/, input: 5, output: 25 },
  { match: /^claude-sonnet-5/, input: 3, output: 15 },
  { match: /^claude-sonnet-4/, input: 3, output: 15 },
  { match: /^claude-haiku-4-5/, input: 1, output: 5 },
  { match: /^claude-3-5-haiku/, input: 0.8, output: 4 },
  { match: /^claude-3-opus/, input: 15, output: 75 },
  { match: /^claude-3-5-sonnet/, input: 3, output: 15 },
];

const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const CACHE_READ_MULT = 0.1;

function findRate(model) {
  if (!model) return null;
  const hit = PRICING.find((p) => p.match.test(model));
  return hit || null;
}

/**
 * usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 * Returns { costUsd: number|null, rateKnown: boolean }
 */
function costForUsage(model, usage) {
  const rate = findRate(model);
  if (!rate || !usage) return { costUsd: null, rateKnown: false };

  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;

  // Split cache-creation tokens by TTL when available (5m vs 1h write price
  // differs 1.25x vs 2x); fall back to treating everything as 5m otherwise.
  const cacheCreation = usage.cache_creation || null;
  const cacheWrite5m = cacheCreation
    ? cacheCreation.ephemeral_5m_input_tokens || 0
    : usage.cache_creation_input_tokens || 0;
  const cacheWrite1h = cacheCreation ? cacheCreation.ephemeral_1h_input_tokens || 0 : 0;

  const cost =
    (input * rate.input) / 1e6 +
    (output * rate.output) / 1e6 +
    (cacheWrite5m * rate.input * CACHE_WRITE_5M_MULT) / 1e6 +
    (cacheWrite1h * rate.input * CACHE_WRITE_1H_MULT) / 1e6 +
    (cacheRead * rate.input * CACHE_READ_MULT) / 1e6;

  return { costUsd: cost, rateKnown: true };
}

module.exports = { costForUsage, findRate };
