import type { RoutePolicyStrategy } from "@llmingress/db/console-route-policies";

/**
 * What each strategy actually does to the candidate order at request time.
 * These strings are product semantics, not decoration — cost_first in
 * particular has to say where unknown prices land.
 */
export const strategyRouteNote: Record<RoutePolicyStrategy, string> = {
  fixed: "tried top to bottom; the next candidate is used only when the one above fails",
  cost_first:
    "ordered by input + output price at request time; candidates with an unknown price are tried last",
  load_balance: "picked per request across healthy candidates; failures fall through in order",
  tag: 'routed by the x-llmingress-route-tag request header; no tag or an unknown tag serves the "default" candidate, and a tagged candidate that fails falls back only to it',
  weighted:
    "split by configured weights that sum to 1.00; each request independently draws a candidate with its weight's probability, and failures fall through the drawn order — 0.00-weight candidates last, as fallback only",
  least_time:
    "ordered by observed latency from real traffic (decayed average; first-byte for streams, full call otherwise); unmeasured candidates go last and are occasionally probed",
};

export const strategyLabel: Record<RoutePolicyStrategy, string> = {
  fixed: "fixed",
  cost_first: "cost_first",
  load_balance: "load_balance",
  tag: "tag",
  weighted: "weighted",
  least_time: "least_time",
};

/** Retries stop the moment the response starts streaming. */
export const RETRY_NOTE =
  "Retries happen before the first byte only — once streaming starts the gateway never replays a request.";
