import {
  resolveVirtualModelCapabilityContract,
  type VirtualModelCapabilityContract,
  validateVirtualModelRequestCapabilities,
} from "@llmingress/domain";
import type { GatewayRoutePolicySnapshot } from "./gateway-config-reload.ts";
import { GatewayPipelineError } from "./gateway-errors.ts";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";

export function assertGatewayVirtualModelCapabilityContract(
  routePolicy: GatewayRoutePolicySnapshot,
): VirtualModelCapabilityContract {
  const result = resolveVirtualModelCapabilityContract(
    routePolicy.candidates.map((candidate) => ({
      id: candidate.providerModelId,
      label: `${candidate.providerKey} - ${candidate.modelId}`,
      inputModalities: candidate.inputModalities,
      maxContextTokens: candidate.contextWindow ?? null,
      maxOutputTokens: candidate.maxOutputTokens,
      outputModalities: candidate.outputModalities,
      supportsFunctionCalling: candidate.supportsFunctionCalling,
      supportsReasoning: candidate.supportsReasoning,
    })),
  );

  if (result.ok) {
    return result.contract;
  }

  throw new GatewayPipelineError("virtual_model_configuration_invalid", result.message);
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
