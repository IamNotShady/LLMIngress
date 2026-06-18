import { describe, expect, it } from "vitest";
import type { GatewayConfigSnapshot } from "../../apps/gateway/src/config-reload";
import { selectRouteCandidate } from "../../apps/gateway/src/route-engine";
import { loadSqlMigrations } from "../../packages/db/src/index";
import {
  normalizeProviderModelCapabilities,
  normalizeRoutePolicyRules,
} from "../../packages/domain/src/index";

describe("feat-106 advanced route policy rules and preview", () => {
  it("declares route rules and provider model capability metadata schema", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0030" && candidate.name === "advanced_route_rules_preview",
    );

    expect(migration?.sql).toContain("alter table route_policies");
    expect(migration?.sql).toContain(
      "add column if not exists rules jsonb not null default '{}'::jsonb",
    );
    expect(migration?.sql).toContain("alter table provider_models");
    expect(migration?.sql).toContain(
      "add column if not exists capability_metadata jsonb not null default '{}'::jsonb",
    );
    expect(migration?.sql).toContain("jsonb_typeof(rules) = 'object'");
    expect(migration?.sql).toContain("jsonb_typeof(capability_metadata) = 'object'");
    expect(migration?.sql).toContain("set version = '0030'");
  });

  it("normalizes and validates route rules and provider capabilities", () => {
    expect(
      normalizeRoutePolicyRules({
        maxContextTokens: 4096,
        requireTools: true,
        requiredCapabilities: ["tools", "reasoning"],
        retryAttempts: 1,
        taskTypes: ["coding"],
        timeoutMs: 2000,
      }),
    ).toEqual({
      maxContextTokens: 4096,
      requireTools: true,
      requiredCapabilities: ["tools", "reasoning"],
      retryAttempts: 1,
      taskTypes: ["coding"],
      timeoutMs: 2000,
    });

    expect(
      normalizeProviderModelCapabilities({
        coding: true,
        maxTimeoutMs: 5000,
        reasoning: true,
        retryable: true,
        tools: true,
      }),
    ).toEqual({
      coding: true,
      maxTimeoutMs: 5000,
      reasoning: true,
      retryable: true,
      tools: true,
    });

    expect(() => normalizeRoutePolicyRules({ taskTypes: ["unknown"] })).toThrow(/task type/i);
    expect(() => normalizeRoutePolicyRules({ maxContextTokens: -1 })).toThrow(/maxContextTokens/i);
    expect(() => normalizeProviderModelCapabilities({ reasoning: "yes" })).toThrow(/reasoning/i);
  });

  it("filters ineligible candidates and explains the selected route", () => {
    const snapshot = createSnapshot({
      candidates: [
        createCandidate({
          candidateOrder: 1,
          capabilities: {
            coding: true,
            maxTimeoutMs: 1000,
            reasoning: false,
            retryable: false,
            tools: false,
          },
          modelId: "cheap-coder",
          price: pricedModel("cheap-coder", 0.1, 0.2),
          providerModelId: "cheap-model",
          supportsTools: false,
        }),
        createCandidate({
          candidateOrder: 2,
          capabilities: {
            coding: true,
            maxTimeoutMs: 5000,
            reasoning: true,
            retryable: true,
            tools: true,
          },
          modelId: "advanced-coder",
          price: pricedModel("advanced-coder", 3, 9),
          providerModelId: "advanced-model",
          supportsTools: true,
        }),
      ],
      rules: {
        requireTools: true,
        requiredCapabilities: ["reasoning", "tools"],
        retryAttempts: 1,
        taskTypes: ["coding"],
        timeoutMs: 2000,
      },
      strategy: "cost_first",
    });

    const decision = selectRouteCandidate({
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 1_000,
      snapshot,
      taskType: "coding",
      usesTools: true,
      virtualModelName: "coding",
    });

    expect(decision).toMatchObject({
      modelId: "advanced-coder",
      providerModelId: "advanced-model",
      routeReason: {
        appliedRules: {
          requireTools: true,
          requiredCapabilities: ["reasoning", "tools"],
          retryAttempts: 1,
          taskTypes: ["coding"],
          timeoutMs: 2000,
        },
        selectedCandidateOrder: 2,
        strategy: "cost_first",
      },
    });
    expect(decision.routeReason.candidateExplanations).toEqual([
      {
        candidateOrder: 1,
        eligible: false,
        providerModelId: "cheap-model",
        reasons: [
          "request uses tools but model does not support tools",
          "missing required capabilities: reasoning, tools",
          "policy timeout 2000ms exceeds model max timeout 1000ms",
          "policy retry attempts require retryable model",
        ],
      },
      {
        candidateOrder: 2,
        eligible: true,
        providerModelId: "advanced-model",
        reasons: ["selected by cost_first strategy"],
      },
    ]);
  });

  it("keeps empty rules compatible with existing cost-first behavior", () => {
    const snapshot = createSnapshot({
      candidates: [
        createCandidate({
          candidateOrder: 1,
          modelId: "expensive",
          price: pricedModel("expensive", 2, 8),
          providerModelId: "expensive-model",
        }),
        createCandidate({
          candidateOrder: 2,
          modelId: "cheap",
          price: pricedModel("cheap", 0.1, 0.4),
          providerModelId: "cheap-model",
        }),
      ],
      rules: {},
      strategy: "cost_first",
    });

    const decision = selectRouteCandidate({
      estimatedInputTokens: 1_000_000,
      estimatedOutputTokens: 1_000_000,
      snapshot,
      virtualModelName: "coding",
    });

    expect(decision).toMatchObject({
      modelId: "cheap",
      providerModelId: "cheap-model",
      routeReason: {
        selectedCandidateOrder: 2,
        strategy: "cost_first",
      },
    });
  });
});

type RoutePolicyInput = GatewayConfigSnapshot["routePolicies"][number];
type RouteCandidateInput = RoutePolicyInput["candidates"][number];

function createSnapshot(input: {
  candidates: RouteCandidateInput[];
  rules: RoutePolicyInput["rules"];
  strategy: RoutePolicyInput["strategy"];
}): GatewayConfigSnapshot {
  return {
    loadedAt: new Date("2026-06-18T00:00:00.000Z"),
    providers: [],
    routePolicies: [
      {
        candidates: input.candidates,
        id: "route-policy",
        rules: input.rules,
        strategy: input.strategy,
        virtualModelId: "virtual-model",
        virtualModelName: "coding",
      },
    ],
    version: 1,
  };
}

function createCandidate(input: {
  candidateOrder: number;
  capabilities?: RouteCandidateInput["capabilities"];
  contextWindow?: number | null;
  modelId: string;
  price: RouteCandidateInput["price"];
  providerModelId: string;
  supportsTools?: boolean;
}): RouteCandidateInput {
  return {
    candidateOrder: input.candidateOrder,
    capabilities: input.capabilities ?? {},
    contextWindow: input.contextWindow ?? null,
    displayName: input.modelId,
    isFallback: false,
    modelId: input.modelId,
    price: input.price,
    providerId: "provider",
    providerKey: "openai",
    providerModelId: input.providerModelId,
    supportsTools: input.supportsTools ?? false,
  };
}

function pricedModel(
  modelId: string,
  inputPrice: number,
  outputPrice: number,
): RouteCandidateInput["price"] {
  return {
    currency: "USD",
    inputUsdPerMillionTokens: inputPrice,
    modelId,
    outputUsdPerMillionTokens: outputPrice,
    priceVersion: "mvp-static-2026-06-13",
    providerKey: "openai",
    snapshotDate: "2026-06-13",
    source: "built_in_static_snapshot",
    sourceUrl: "https://example.test/pricing",
    status: "priced",
    unit: "per_1m_tokens",
  };
}
