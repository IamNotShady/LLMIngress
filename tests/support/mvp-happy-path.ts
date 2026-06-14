export const mvpHappyPathNames = {
  initialProviderModelDisplayName: "GPT 4.1 Mini",
  initialProviderModelId: "gpt-4.1-mini",
  providerDisplayName: "MVP Happy Provider",
  providerKey: "mvp-openai",
  reloadedProviderModelDisplayName: "GPT 4.1 Nano",
  reloadedProviderModelId: "gpt-4.1-nano",
  virtualModelDisplayName: "MVP Happy",
  virtualModelName: "mvp-happy",
} as const;

export function buildMvpHappyPathRequestId(phase: "initial" | "reloaded"): string {
  return `req_mvp_${phase}_050`;
}

export function buildMvpHappyPathModelOptionLabel(input: {
  modelDisplayName: string;
  modelId: string;
  providerDisplayName: string;
}): string {
  return `${input.providerDisplayName} - ${input.modelDisplayName} (${input.modelId})`;
}
