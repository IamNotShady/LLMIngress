import {
  calculateTokenCostUsd,
  resolveEffectiveModelTokenPrice,
} from "@llmingress/billing/price-registry";
import { cookies } from "next/headers";
import { getConsoleDatabaseUrl, readConsoleAuthState, sessionCookieName } from "../server/auth";
import { getManualPriceOverride } from "../server/price-overrides";

const previewProviderKey = "openai";
const previewModelId = "gpt-4.1-mini";

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
