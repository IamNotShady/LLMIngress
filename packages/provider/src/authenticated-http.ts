export const providerRedirectRejectedCode = "provider_redirect_rejected" as const;
export const providerRequestTimeoutCode = "provider_request_timeout" as const;

export class ProviderRedirectRejectedError extends Error {
  readonly code = providerRedirectRejectedCode;
  readonly retryable = false;

  constructor(readonly statusCode: number) {
    super("Provider returned a redirect. Configure the final provider URL.");
    this.name = "ProviderRedirectRejectedError";
  }
}

export class ProviderRequestTimeoutError extends Error {
  readonly code = providerRequestTimeoutCode;
  readonly retryable = true;

  constructor() {
    super("Provider request timed out.");
    this.name = "ProviderRequestTimeoutError";
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

export async function fetchCredentialedProviderRequestWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  options: { timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    return await fetchCredentialedProviderRequest(fetchImpl, url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderRequestTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isProviderRedirectRejectedError(
  error: unknown,
): error is ProviderRedirectRejectedError {
  return error instanceof ProviderRedirectRejectedError;
}

export function isProviderRequestTimeoutError(
  error: unknown,
): error is ProviderRequestTimeoutError {
  return error instanceof ProviderRequestTimeoutError;
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}
