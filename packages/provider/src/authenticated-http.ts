export const providerRedirectRejectedCode = "provider_redirect_rejected" as const;

export class ProviderRedirectRejectedError extends Error {
  readonly code = providerRedirectRejectedCode;
  readonly retryable = false;

  constructor(readonly statusCode: number) {
    super("Provider returned a redirect. Configure the final provider URL.");
    this.name = "ProviderRedirectRejectedError";
  }
}

export async function fetchCredentialedProviderRequest(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "manual",
  });
  if (isRedirectStatus(response.status)) {
    throw new ProviderRedirectRejectedError(response.status);
  }
  return response;
}

export function isProviderRedirectRejectedError(
  error: unknown,
): error is ProviderRedirectRejectedError {
  return error instanceof ProviderRedirectRejectedError;
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}
