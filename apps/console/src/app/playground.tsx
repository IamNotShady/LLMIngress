"use client";

import { useState } from "react";
import {
  buildPlaygroundChatRequest,
  formatPlaygroundFetchError,
  isValidPlaygroundGatewayBaseUrl,
  normalizePlaygroundGatewayBaseUrl,
  readPlaygroundResponseText,
} from "./playground-helpers";

type PlaygroundProps = {
  defaultGatewayBaseUrl: string;
};

type PlaygroundModel = {
  id: string;
};

type PlaygroundResult = {
  requestId: string;
  responseText: string;
};

export function Playground({ defaultGatewayBaseUrl }: PlaygroundProps) {
  const [agentApiKey, setAgentApiKey] = useState("");
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(defaultGatewayBaseUrl);
  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [prompt, setPrompt] = useState("hello from LLMIngress Playground");
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [status, setStatus] = useState("Paste an Agent API key to load models.");

  async function loadAllowedModels() {
    setResult(null);
    const normalizedGatewayBaseUrl = readSafeGatewayBaseUrl(gatewayBaseUrl);
    if (!normalizedGatewayBaseUrl) {
      setStatus("Gateway base URL must be an absolute http(s) URL.");
      return;
    }

    let response: Response;
    try {
      response = await fetch(`${normalizedGatewayBaseUrl}/v1/models`, {
        headers: {
          authorization: `Bearer ${agentApiKey}`,
        },
      });
    } catch (error) {
      setStatus(formatPlaygroundFetchError("loading allowed models", error));
      return;
    }
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      setStatus(readGatewayErrorMessage(body, "Failed to load allowed models."));
      return;
    }

    const allowedModels = readGatewayModels(body);
    setModels(allowedModels);
    setSelectedModel(allowedModels[0]?.id ?? "");
    setStatus(
      allowedModels.length === 0 ? "No allowed Virtual Models returned." : "Allowed models loaded.",
    );
  }

  async function sendLiveRequest() {
    const normalizedGatewayBaseUrl = readSafeGatewayBaseUrl(gatewayBaseUrl);
    if (!normalizedGatewayBaseUrl) {
      setStatus("Gateway base URL must be an absolute http(s) URL.");
      return;
    }

    const requestId = createPlaygroundRequestId();
    let response: Response;
    try {
      response = await fetch(`${normalizedGatewayBaseUrl}/v1/chat/completions`, {
        body: JSON.stringify(
          buildPlaygroundChatRequest({
            model: selectedModel,
            prompt,
          }),
        ),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        method: "POST",
      });
    } catch (error) {
      setResult(null);
      setStatus(formatPlaygroundFetchError("sending a live request", error));
      return;
    }
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      setResult(null);
      setStatus(readGatewayErrorMessage(body, "Playground request failed."));
      return;
    }

    setStatus("Playground request completed.");
    setResult({
      requestId,
      responseText: readPlaygroundResponseText(body),
    });
  }

  return (
    <section className="providers-panel" id="playground" aria-label="Playground">
      <div className="playground-layout">
        <div className="chart-card">
          <h2 className="chart-card-title">Request config</h2>
          <div className="playground-config">
            <div className="console-field">
              <label htmlFor="playground-gateway-base-url">Gateway base URL</label>
              <input
                id="playground-gateway-base-url"
                value={gatewayBaseUrl}
                onChange={(event) => setGatewayBaseUrl(event.target.value)}
              />
            </div>
            <div className="console-field">
              <label htmlFor="playground-agent-api-key">Agent API key</label>
              <input
                id="playground-agent-api-key"
                type="password"
                autoComplete="off"
                value={agentApiKey}
                onChange={(event) => setAgentApiKey(event.target.value)}
              />
            </div>
            <div className="console-actions">
              <button type="button" onClick={() => void loadAllowedModels()}>
                Load allowed models
              </button>
            </div>
            <div className="console-field">
              <label htmlFor="playground-model">Playground model</label>
              <select
                id="playground-model"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                <option value="">Select model</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="console-field">
              <label htmlFor="playground-prompt">Playground prompt</label>
              <textarea
                id="playground-prompt"
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>
            <div className="console-actions">
              <button
                type="button"
                disabled={!agentApiKey || !selectedModel}
                onClick={() => void sendLiveRequest()}
              >
                Send live request
              </button>
            </div>
          </div>
        </div>

        <div className="chart-card">
          <h2 className="chart-card-title">Response preview</h2>
          <div className="playground-result" role="status">
            <p>{status}</p>
            {result ? (
              <>
                <p className="detail-section-label">Request &amp; routing detail</p>
                <dl className="detail-field-list">
                  <div className="detail-field">
                    <dt>Request ID</dt>
                    <dd className="mono">{result.requestId}</dd>
                  </div>
                  <div className="detail-field">
                    <dt>Model</dt>
                    <dd>{selectedModel}</dd>
                  </div>
                </dl>
                <p className="detail-section-label">Playground response</p>
                <pre className="code-block">{result.responseText}</pre>
              </>
            ) : (
              <p className="callout">
                Send a request to preview the response and routing detail here.
              </p>
            )}
          </div>
          <p className="callout callout--info">
            The Agent API key stays in your browser; the Console backend never stores it.
          </p>
        </div>
      </div>
    </section>
  );
}

function createPlaygroundRequestId(): string {
  return `playground_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readSafeGatewayBaseUrl(value: string): string | null {
  if (!isValidPlaygroundGatewayBaseUrl(value)) {
    return null;
  }
  return normalizePlaygroundGatewayBaseUrl(value);
}

function readGatewayModels(body: unknown): PlaygroundModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return [];
  }

  return body.data
    .map((model) => {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) {
        return null;
      }
      return { id: model.id.trim() };
    })
    .filter((model): model is PlaygroundModel => model !== null);
}

function readGatewayErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
