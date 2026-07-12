import { consoleValidationError } from "./console-operation-error.ts";

export function normalizeProviderBaseUrl(input: {
  providerType: "api_key" | "local" | "subscription";
  value: string | null | undefined;
}): string {
  const value = input.value?.trim();
  if (!value) {
    throw consoleValidationError("Provider base URL is required.", "provider_base_url_required", {
      field: "baseUrl",
    });
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw consoleValidationError(
      "Provider base URL must be a valid URL.",
      "provider_base_url_invalid",
      { field: "baseUrl" },
      cause,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw consoleValidationError(
      "Provider base URL must use http or https.",
      "provider_base_url_protocol_invalid",
      { field: "baseUrl" },
    );
  }
  if (url.username || url.password) {
    throw consoleValidationError(
      "Provider base URL must not contain credentials.",
      "provider_base_url_credentials_invalid",
      { field: "baseUrl" },
    );
  }
  if (
    input.providerType !== "local" &&
    url.protocol !== "https:" &&
    !isLoopbackHostname(url.hostname)
  ) {
    throw consoleValidationError(
      "Remote Provider base URL must use https unless it targets loopback.",
      "provider_base_url_https_required",
      { field: "baseUrl" },
    );
  }

  const pathname =
    url.pathname === "/"
      ? ""
      : url.pathname.length > 1 && url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;
  return `${url.origin}${pathname}${url.search}`;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
