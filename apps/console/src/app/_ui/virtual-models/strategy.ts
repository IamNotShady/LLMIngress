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
};

export const strategyLabel: Record<RoutePolicyStrategy, string> = {
  fixed: "fixed",
  cost_first: "cost_first",
  load_balance: "load_balance",
};

/** Retries stop the moment the response starts streaming. */
export const RETRY_NOTE =
  "Retries happen before the first byte only — once streaming starts the gateway never replays a request.";
