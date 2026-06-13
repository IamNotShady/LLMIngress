import {
  calculateTokenCostUsd,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import { cookies } from "next/headers";
import { getConsoleDatabaseUrl, readConsoleAuthState, sessionCookieName } from "../server/auth";
import { getManualPriceOverride } from "../server/price-overrides";
import { listProviderApiKeyMetadata } from "../server/provider-keys";
import { listOpenAICompatibleProviderTemplates } from "../server/provider-templates";
import { listProviders } from "../server/providers";

const previewProviderKey = "openai";
const previewModelId = "gpt-4.1-mini";
const providerTemplates = listOpenAICompatibleProviderTemplates();

export default async function Home() {
  const cookieStore = await cookies();
  const databaseUrl = getConsoleDatabaseUrl();
  const authState = await readConsoleAuthState(
    databaseUrl,
    cookieStore.get(sessionCookieName)?.value,
  );

  if (authState === "setup") {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="setup-title">
          <p className="eyebrow">LLMIngress</p>
          <h1 id="setup-title">First run setup</h1>
          <form className="form" action="/api/auth/setup" method="post">
            <label htmlFor="setup-password">Admin password</label>
            <input
              id="setup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <button type="submit">Create admin</button>
          </form>
        </section>
      </main>
    );
  }

  if (authState === "login") {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="login-title">
          <p className="eyebrow">LLMIngress</p>
          <h1 id="login-title">Sign in</h1>
          <form className="form" action="/api/auth/login" method="post">
            <label htmlFor="login-password">Admin password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button type="submit">Sign in</button>
          </form>
        </section>
      </main>
    );
  }

  const pricePanel = await getPricePanel(databaseUrl);
  const providers = await listProviders(databaseUrl);
  const providerKeys = await listProviderApiKeyMetadata(databaseUrl);
  const providerKeyByProviderId = new Map(
    providerKeys.map((providerKey) => [providerKey.providerId, providerKey]),
  );

  return (
    <main className="console-page">
      <header className="topbar">
        <div>
          <p className="eyebrow">LLMIngress</p>
          <h1>Dashboard</h1>
        </div>
        <form action="/api/auth/logout" method="post">
          <button className="secondary-button" type="submit">
            Sign out
          </button>
        </form>
      </header>
      <section className="status-band" aria-label="Console status">
        <p>Signed in as admin</p>
      </section>
      <section className="price-panel" aria-labelledby="price-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Prices</p>
            <h2 id="price-title">{previewModelId}</h2>
          </div>
          <p className="price-source">{pricePanel.sourceLabel}</p>
        </div>
        <dl className="price-grid">
          <div>
            <dt>Input</dt>
            <dd>{pricePanel.inputPriceLabel}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{pricePanel.outputPriceLabel}</dd>
          </div>
          <div>
            <dt>Estimate</dt>
            <dd>{pricePanel.estimateLabel}</dd>
          </div>
        </dl>
        <form className="price-form" action="/api/prices/override" method="post">
          <input type="hidden" name="providerKey" value={previewProviderKey} />
          <input type="hidden" name="modelId" value={previewModelId} />
          <label htmlFor="override-input-price">Override input price</label>
          <input
            id="override-input-price"
            name="inputUsdPerMillionTokens"
            type="number"
            min="0"
            step="0.00000001"
            defaultValue={pricePanel.inputPriceValue}
            required
          />
          <label htmlFor="override-output-price">Override output price</label>
          <input
            id="override-output-price"
            name="outputUsdPerMillionTokens"
            type="number"
            min="0"
            step="0.00000001"
            defaultValue={pricePanel.outputPriceValue}
            required
          />
          <button type="submit">Save price override</button>
        </form>
      </section>
      <section className="providers-panel" aria-labelledby="providers-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Providers</p>
            <h2 id="providers-title">Provider configurations</h2>
          </div>
        </div>
        <form className="provider-create-form" action="/api/providers" method="post">
          <input type="hidden" name="action" value="create" />
          <input type="hidden" name="providerType" value="api_key" />
          <label htmlFor="provider-key">Provider key</label>
          <input id="provider-key" name="providerKey" required />
          <label htmlFor="provider-display-name">Provider display name</label>
          <input id="provider-display-name" name="displayName" required />
          <label htmlFor="provider-base-url">Provider base URL</label>
          <input id="provider-base-url" name="baseUrl" type="url" />
          <button type="submit">Create provider</button>
        </form>
        <form className="provider-template-form" action="/api/providers" method="post">
          <input type="hidden" name="action" value="createFromTemplate" />
          <label htmlFor="provider-template">Provider template</label>
          <select id="provider-template" name="templateId" required>
            {providerTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.displayName}
              </option>
            ))}
          </select>
          <button type="submit">Add template provider</button>
        </form>
        <div className="provider-list">
          {providers.length === 0 ? (
            <p>No providers configured.</p>
          ) : (
            providers.map((provider) => {
              const providerKeyMetadata = providerKeyByProviderId.get(provider.id);

              return (
                <article className="provider-item" key={provider.id}>
                  <header className="provider-header">
                    <div>
                      <p className="eyebrow">{provider.providerKey}</p>
                      <h2>{provider.displayName}</h2>
                    </div>
                    <p className={provider.enabled ? "status-enabled" : "status-disabled"}>
                      {provider.enabled ? "Enabled" : "Disabled"}
                    </p>
                  </header>
                  <form className="provider-edit-form" action="/api/providers" method="post">
                    <input type="hidden" name="action" value="update" />
                    <input type="hidden" name="id" value={provider.id} />
                    <label htmlFor={`provider-display-${provider.id}`}>
                      Edit provider display name
                    </label>
                    <input
                      id={`provider-display-${provider.id}`}
                      name="displayName"
                      defaultValue={provider.displayName}
                      required
                    />
                    {provider.providerTemplateId ? (
                      <p>Template provider base URL: {provider.baseUrl}</p>
                    ) : (
                      <>
                        <label htmlFor={`provider-base-${provider.id}`}>
                          Edit provider base URL
                        </label>
                        <input
                          id={`provider-base-${provider.id}`}
                          name="baseUrl"
                          type="url"
                          defaultValue={provider.baseUrl ?? ""}
                        />
                      </>
                    )}
                    <button type="submit">Save provider</button>
                  </form>
                  <div className="provider-key-metadata">
                    {providerKeyMetadata ? (
                      <>
                        <p>Provider API key prefix: {providerKeyMetadata.keyPrefix}</p>
                        <p>
                          Provider API key created: {formatDateTime(providerKeyMetadata.createdAt)}
                        </p>
                        {providerKeyMetadata.rotatedAt ? (
                          <p>
                            Provider API key rotated:{" "}
                            {formatDateTime(providerKeyMetadata.rotatedAt)}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p>No Provider API key saved.</p>
                    )}
                  </div>
                  <form className="provider-key-form" action="/api/provider-keys" method="post">
                    <input type="hidden" name="providerId" value={provider.id} />
                    <label htmlFor={`provider-api-key-${provider.id}`}>Provider API key</label>
                    <input
                      id={`provider-api-key-${provider.id}`}
                      name="providerApiKey"
                      type="password"
                      autoComplete="off"
                      required
                    />
                    <button type="submit">
                      {providerKeyMetadata ? "Rotate provider API key" : "Store provider API key"}
                    </button>
                  </form>
                  <form action="/api/providers" method="post">
                    <input type="hidden" name="id" value={provider.id} />
                    <input
                      type="hidden"
                      name="action"
                      value={provider.enabled ? "disable" : "enable"}
                    />
                    <button className="secondary-button" type="submit">
                      {provider.enabled ? "Disable provider" : "Enable provider"}
                    </button>
                  </form>
                </article>
              );
            })
          )}
        </div>
      </section>
    </main>
  );
}

async function getPricePanel(databaseUrl: string) {
  const manualOverride = await getManualPriceOverride({
    databaseUrl,
    modelId: previewModelId,
    providerKey: previewProviderKey,
  });
  const price = resolveEffectiveModelTokenPrice({
    manualOverride,
    modelId: previewModelId,
    providerKey: previewProviderKey,
  });

  if (price.status === "unknown_price") {
    return {
      estimateLabel: "Sample estimate: unavailable",
      inputPriceLabel: "Unknown input price",
      inputPriceValue: "",
      outputPriceLabel: "Unknown output price",
      outputPriceValue: "",
      sourceLabel: "Unknown price",
    };
  }

  const estimate = calculateTokenCostUsd(price, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  const totalCost = estimate.status === "estimated" ? estimate.totalCostUsd : 0;

  return {
    estimateLabel: `Sample estimate: ${formatUsd(totalCost)}`,
    inputPriceLabel: `${formatUsd(price.inputUsdPerMillionTokens)} / 1M input`,
    inputPriceValue: String(price.inputUsdPerMillionTokens),
    outputPriceLabel: `${formatUsd(price.outputUsdPerMillionTokens)} / 1M output`,
    outputPriceValue: String(price.outputUsdPerMillionTokens),
    sourceLabel: price.source === "manual_override" ? "Manual override" : "Built-in price",
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatDateTime(value: Date): string {
  return value.toISOString();
}
