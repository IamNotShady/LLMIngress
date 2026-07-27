import { readConsoleActivityRouteCandidates } from "@llmingress/db/console-activity";
import { describe, expect, it } from "vitest";

/**
 * The shape the gateway records, from resolveRouteDecision. Every candidate is
 * written with `eligible: true` — the router orders candidates and the chain
 * stops at the first that serves, so nothing is ruled out beforehand — which is
 * why the console reads this for the list and its order, and takes what became
 * of each from the attempts.
 */
const recorded = {
  candidateExplanations: [
    {
      candidateOrder: 2,
      eligible: true,
      providerModelId: "22222222-2222-4222-8222-222222222222",
      reasons: ["eligible but not selected by cost_first strategy"],
    },
    {
      candidateOrder: 1,
      eligible: true,
      providerModelId: "11111111-1111-4111-8111-111111111111",
      reasons: ["selected by cost_first strategy"],
    },
  ],
  message: "cost_first route for caps-vm",
  selectedCandidateOrder: 1,
};

describe("what the gateway recorded about the route", () => {
  it("reads every candidate it weighed, in the order the policy has them", () => {
    expect(readConsoleActivityRouteCandidates(recorded)).toEqual([
      { candidateOrder: 1, providerModelId: "11111111-1111-4111-8111-111111111111" },
      { candidateOrder: 2, providerModelId: "22222222-2222-4222-8222-222222222222" },
    ]);
  });

  it("has nothing to say about a request whose route predates the field", () => {
    // Requests recorded before candidateExplanations existed, and requests that
    // never reached a policy at all, are not a route with no candidates —
    // they are a route with nothing recorded, and the panel stays away.
    expect(readConsoleActivityRouteCandidates({ message: "fixed route" })).toEqual([]);
    expect(readConsoleActivityRouteCandidates(null)).toEqual([]);
    expect(readConsoleActivityRouteCandidates("cost_first")).toEqual([]);
    expect(readConsoleActivityRouteCandidates({ candidateExplanations: "many" })).toEqual([]);
  });

  it("keeps what it can read of a half-recorded explanation", () => {
    expect(
      readConsoleActivityRouteCandidates({
        candidateExplanations: [
          { providerModelId: "33333333-3333-4333-8333-333333333333" },
          { candidateOrder: 9, reasons: ["no id"] },
          { candidateOrder: 4, providerModelId: "44444444-4444-4444-8444-444444444444" },
        ],
      }),
    ).toEqual([
      // No order recorded: its position stands in, so the row can still be
      // numbered without inventing an order the policy did not have.
      { candidateOrder: 1, providerModelId: "33333333-3333-4333-8333-333333333333" },
      { candidateOrder: 4, providerModelId: "44444444-4444-4444-8444-444444444444" },
    ]);
  });
});
