export const localDeploymentSmokeNames = {
  agentApiKey: "llmi_deploy054_key_054",
  providerDisplayName: "Local Deploy Provider",
  providerKey: "openai",
  providerModelDisplayName: "GPT 4.1 Mini",
  providerModelId: "gpt-4.1-mini",
  virtualModelDisplayName: "Local Deploy Smoke",
  virtualModelName: "local-deploy-smoke",
} as const;

export type LocalDeploymentComponentName = "postgres" | "gateway" | "console" | "worker";

export type LocalDeploymentComponent = {
  name: LocalDeploymentComponentName;
  displayName: string;
  healthSignal: string;
};

/**
 * The four components a clean MVP local deployment must bring up, each with the
 * signal feat-054 uses to confirm it is healthy.
 */
export const localDeploymentSmokeComponents: readonly LocalDeploymentComponent[] = [
  { name: "postgres", displayName: "PostgreSQL", healthSignal: "migrations applied" },
  { name: "gateway", displayName: "Gateway", healthSignal: "GET /health returns 200" },
  { name: "console", displayName: "Console", healthSignal: "GET / returns 200" },
  { name: "worker", displayName: "Worker", healthSignal: "[worker] started logged" },
];

export function buildLocalDeploymentRequestId(
  phase: "smoke" | "real-openai" | "real-anthropic",
): string {
  return `req_local_deploy_${phase.replaceAll("-", "_")}_054`;
}
