import {
  resolveVirtualModelCapabilityContract,
  routeStrategyCapabilityContractScope,
  type VirtualModelCapabilityContract,
  type VirtualModelCapabilityContractCandidate,
  validateVirtualModelRequestCapabilities,
} from "@llmingress/domain";
import type {
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./gateway-config-reload.ts";
import { GatewayPipelineError } from "./gateway-errors.ts";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";

export function assertGatewayVirtualModelCapabilityContract(
  routePolicy: GatewayRoutePolicySnapshot,
): VirtualModelCapabilityContract {
  return requireVirtualModelCapabilityContract(
    routePolicy.candidates.map(readVirtualModelContractCandidate),
  );
}

/**
 * Validates the request against the capabilities the selected strategy makes
 * the request's contract. Strategies that order the whole configured set share
 * one contract across every candidate; a strategy that routes one named
 * candidate per request is checked against that candidate alone, because its
 * candidates are deliberately unequal.
 */
export function assertGatewayRequestWithinVirtualModelCapabilities(input: {
  chain: readonly GatewayRouteCandidateSnapshot[];
  requestMetadata: GatewayRequestMetadata;
  routePolicy: GatewayRoutePolicySnapshot;
}): void {
  const contract =
    routeStrategyCapabilityContractScope(input.routePolicy.strategy) === "selected_candidate"
      ? readSelectedCandidateCapabilityContract(input.chain)
      : assertGatewayVirtualModelCapabilityContract(input.routePolicy);

  assertGatewayRequestWithinVirtualModelContract(contract, input.requestMetadata);
}

export function assertGatewayRequestWithinVirtualModelContract(
  contract: VirtualModelCapabilityContract,
  requestMetadata: GatewayRequestMetadata,
): void {
  const result = validateVirtualModelRequestCapabilities(contract, {
    estimatedInputTokens: requestMetadata.estimatedInputTokens,
    estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
    inputModalities: requestMetadata.inputModalities,
    outputModalities: requestMetadata.outputModalities,
    usesFunctionCalling: requestMetadata.usesTools,
    usesReasoning: requestMetadata.usesReasoning,
  });

  if (!result.ok) {
    throw new GatewayPipelineError("virtual_model_capability_mismatch", result.message);
  }
}

function readSelectedCandidateCapabilityContract(
  chain: readonly GatewayRouteCandidateSnapshot[],
): VirtualModelCapabilityContract {
  const selectedCandidate = chain[0];
  if (!selectedCandidate) {
    throw new GatewayPipelineError(
      "provider_unavailable",
      "Route selection produced no candidate to check the request against.",
    );
  }

  return requireVirtualModelCapabilityContract([
    readVirtualModelContractCandidate(selectedCandidate),
  ]);
}

function requireVirtualModelCapabilityContract(
  candidates: readonly VirtualModelCapabilityContractCandidate[],
): VirtualModelCapabilityContract {
  const result = resolveVirtualModelCapabilityContract(candidates);
  if (result.ok) {
    return result.contract;
  }

  throw new GatewayPipelineError("virtual_model_configuration_invalid", result.message);
}

function readVirtualModelContractCandidate(
  candidate: GatewayRouteCandidateSnapshot,
): VirtualModelCapabilityContractCandidate {
  return {
    id: candidate.providerModelId,
    label: `${candidate.providerKey} - ${candidate.modelId}`,
    inputModalities: candidate.inputModalities,
    maxContextTokens: candidate.contextWindow ?? null,
    maxOutputTokens: candidate.maxOutputTokens,
    outputModalities: candidate.outputModalities,
    supportsFunctionCalling: candidate.supportsFunctionCalling,
    supportsReasoning: candidate.supportsReasoning,
  };
}
