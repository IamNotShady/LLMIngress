"use client";

import { useRef, useState } from "react";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  formatPlaygroundFetchError,
  isValidPlaygroundGatewayBaseUrl,
  normalizePlaygroundGatewayBaseUrl,
  type PlaygroundProtocol,
  type PlaygroundRequestInput,
  readOptionalPlaygroundNumber,
  readPlaygroundResponseText,
  readPlaygroundStreamResponseText,
} from "./playground-helpers";

type PlaygroundProps = {
  defaultGatewayBaseUrl: string;
};

type PlaygroundModel = {
  id: string;
};

type PlaygroundRequestDetail = {
  latencyMs: number | null;
  providerDisplayName: string | null;
  providerKey: string | null;
  providerModelDisplayName: string | null;
  providerModelName: string | null;
  requestId: string;
  routePolicyStrategy: string | null;
  status: string | null;
  totalCostUsd: string | null;
  totalTokens: number | null;
  virtualModelName: string | null;
};

type PlaygroundResult = {
  detail: PlaygroundRequestDetail | null;
  requestId: string;
  responseText: string;
  responseTokenCount: number | null;
};

const endpointOptions: Array<{ label: string; value: PlaygroundProtocol }> = [
  { label: "/v1/chat/completions", value: "chat_completions" },
  { label: "/v1/messages", value: "messages" },
  { label: "/v1/responses", value: "responses" },
];

export function Playground({ defaultGatewayBaseUrl }: PlaygroundProps) {
  const gatewayBaseUrl = defaultGatewayBaseUrl;
  const agentApiKeyRef = useRef("");
  const modelLoadTimerRef = useRef<number | null>(null);
  const [agentApiKey, setAgentApiKey] = useState("");
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [maxTokens, setMaxTokens] = useState("1024");
  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [prompt, setPrompt] = useState("Explain the core benefits of LLMIngress.");
  const [protocol, setProtocol] = useState<PlaygroundProtocol>("chat_completions");
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [status, setStatus] = useState("Enter an Agent API Key to send a test.");
  const [statusTone, setStatusTone] = useState<"error" | "idle" | "success">("idle");
  const [streamMode, setStreamMode] = useState<"off" | "on">("off");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a professional technical assistant. Answer accurately and concisely.",
  );
  const [temperature, setTemperature] = useState("0.7");
  const [topP, setTopP] = useState("0.9");

  async function loadAllowedModels(
    options: { agentApiKey?: string; announce?: boolean } = {},
  ): Promise<PlaygroundModel[]> {
    const apiKey = (options.agentApiKey ?? agentApiKey).trim();
    if (!apiKey) {
      if (options.announce !== false) {
        setStatus("Enter an Agent API Key first.");
        setStatusTone("error");
      }
      return [];
    }

    const normalizedGatewayBaseUrl = readSafeGatewayBaseUrl(gatewayBaseUrl);
    if (!normalizedGatewayBaseUrl) {
      setStatus("Gateway base URL must be an absolute http(s) URL.");
      setStatusTone("error");
      return [];
    }

    setIsLoadingModels(true);
    try {
      let response: Response;
      try {
        response = await fetch(`${normalizedGatewayBaseUrl}/v1/models`, {
          headers: {
            authorization: `Bearer ${apiKey}`,
          },
        });
      } catch (error) {
        setStatus(formatPlaygroundFetchError("loading allowed models", error));
        setStatusTone("error");
        return [];
      }
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setStatus(readGatewayErrorMessage(body, "Failed to load allowed models."));
        setStatusTone("error");
        return [];
      }

      const allowedModels = readGatewayModels(body);
      if (apiKey !== agentApiKeyRef.current.trim()) {
        return [];
      }
      setModels(allowedModels);
      setSelectedModel((current) => current || allowedModels[0]?.id || "");
      if (options.announce !== false) {
        setStatus(
          allowedModels.length === 0
            ? "No allowed Virtual Models returned."
            : "Allowed models loaded.",
        );
        setStatusTone("idle");
      }
      return allowedModels;
    } finally {
      setIsLoadingModels(false);
    }
  }

  function scheduleAllowedModelsLoad(nextApiKey: string) {
    if (modelLoadTimerRef.current !== null) {
      window.clearTimeout(modelLoadTimerRef.current);
    }
    const apiKey = nextApiKey.trim();
    if (!apiKey) {
      modelLoadTimerRef.current = null;
      return;
    }
    modelLoadTimerRef.current = window.setTimeout(() => {
      modelLoadTimerRef.current = null;
      void loadAllowedModels({ agentApiKey: apiKey, announce: false });
    }, 350);
  }

  async function sendLiveRequest() {
    const normalizedGatewayBaseUrl = readSafeGatewayBaseUrl(gatewayBaseUrl);
    if (!normalizedGatewayBaseUrl) {
      setStatus("Gateway base URL must be an absolute http(s) URL.");
      setStatusTone("error");
      return;
    }

    const requestParams = readPlaygroundRequestParams({
      maxTokens,
      prompt,
      stream: streamMode,
      systemPrompt,
      temperature,
      topP,
    });
    if (!agentApiKey.trim()) {
      setStatus("Enter an Agent API Key first.");
      setStatusTone("error");
      return;
    }
    if (!requestParams.prompt.trim()) {
      setStatus("Prompt cannot be empty.");
      setStatusTone("error");
      return;
    }

    let model = selectedModel;
    if (!model) {
      const loadedModels =
        models.length > 0 ? models : await loadAllowedModels({ announce: false });
      model = loadedModels[0]?.id ?? "";
      if (model) {
        setSelectedModel(model);
      }
    }
    if (!model) {
      setStatus("No allowed Virtual Models returned.");
      setStatusTone("error");
      return;
    }

    const requestId = createPlaygroundRequestId();
    const endpointPath = readPlaygroundEndpointPath(protocol);
    const requestBody = buildPlaygroundRequestBody(protocol, { ...requestParams, model });
    setIsSending(true);
    setResult(null);
    setStatus("Sending test request.");
    setStatusTone("idle");

    try {
      let response: Response;
      try {
        response = await fetch(`${normalizedGatewayBaseUrl}${endpointPath}`, {
          body: JSON.stringify(requestBody),
          headers: {
            authorization: `Bearer ${agentApiKey}`,
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          method: "POST",
        });
      } catch (error) {
        setStatus(formatPlaygroundFetchError("sending a live request", error));
        setStatusTone("error");
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const isStreamResponse = contentType.includes("text/event-stream");
      const body: unknown = isStreamResponse
        ? response.ok
          ? null
          : await response.text().catch(() => "")
        : await response.json().catch(() => null);

      if (!response.ok) {
        setStatus(readGatewayErrorMessage(body, "Playground request failed."));
        setStatusTone("error");
        return;
      }

      const responseRequestId = response.headers.get("x-request-id")?.trim() || requestId;
      if (isStreamResponse) {
        const streamResult: PlaygroundResult = {
          detail: null,
          requestId: responseRequestId,
          responseText: "",
          responseTokenCount: null,
        };
        setResult(streamResult);
        setStatus("Receiving streaming response.");
        const responseText = await readPlaygroundStreamBody(response, (nextText) => {
          setResult({ ...streamResult, responseText: nextText });
        });
        const nextResult = { ...streamResult, responseText };
        setResult(nextResult);
        setStatus("Playground request completed.");
        setStatusTone("success");

        const detail = await fetchPlaygroundRequestDetail(responseRequestId);
        if (detail) {
          setResult({ ...nextResult, detail });
        }
        return;
      }

      const nextResult: PlaygroundResult = {
        detail: null,
        requestId: responseRequestId,
        responseText: readPlaygroundResponseText(body),
        responseTokenCount: readPlaygroundResponseTokenCount(body),
      };
      setResult(nextResult);
      setStatus("Playground request completed.");
      setStatusTone("success");

      const detail = await fetchPlaygroundRequestDetail(responseRequestId);
      if (detail) {
        setResult({ ...nextResult, detail });
      }
    } finally {
      setIsSending(false);
    }
  }

  function clearPlayground() {
    setPrompt("");
    setResult(null);
    setStatus("Request content cleared.");
    setStatusTone("idle");
    setSystemPrompt("");
  }

  const providerModelLabel = readProviderModelLabel(result, selectedModel);
  const statusLabel =
    statusTone === "success"
      ? "Success"
      : statusTone === "error"
        ? "Failed"
        : isSending
          ? "Sending"
          : "Not sent";
  const detail = result?.detail ?? null;
  const displayTokens = detail?.totalTokens ?? result?.responseTokenCount ?? null;

  return (
    <section className="playground-dashboard" id="playground" aria-label="Playground">
      <div className="playground-layout">
        <form
          className="playground-card playground-config-card"
          onSubmit={(event) => {
            event.preventDefault();
            void sendLiveRequest();
          }}
        >
          <h2 className="playground-card-title">Request configuration</h2>
          <div className="playground-config">
            <div className="console-field playground-field">
              <label htmlFor="playground-agent-api-key">1. Agent API Key</label>
              <input
                id="playground-agent-api-key"
                type="password"
                autoComplete="off"
                placeholder="llmi_************************"
                value={agentApiKey}
                onBlur={() => {
                  if (agentApiKey.trim() && models.length === 0 && !isLoadingModels) {
                    if (modelLoadTimerRef.current !== null) {
                      window.clearTimeout(modelLoadTimerRef.current);
                      modelLoadTimerRef.current = null;
                    }
                    void loadAllowedModels({ announce: false });
                  }
                }}
                onChange={(event) => {
                  const nextApiKey = event.target.value;
                  agentApiKeyRef.current = nextApiKey;
                  setAgentApiKey(nextApiKey);
                  setModels([]);
                  setSelectedModel("");
                  scheduleAllowedModelsLoad(nextApiKey);
                }}
              />
            </div>

            <div className="console-field playground-field">
              <label htmlFor="playground-endpoint">2. Endpoint</label>
              <select
                id="playground-endpoint"
                value={protocol}
                onChange={(event) => setProtocol(event.target.value as PlaygroundProtocol)}
              >
                {endpointOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="console-field playground-field">
              <label htmlFor="playground-model">3. Virtual Model</label>
              <select
                id="playground-model"
                value={selectedModel}
                onFocus={() => {
                  if (agentApiKey.trim() && models.length === 0 && !isLoadingModels) {
                    void loadAllowedModels({ announce: false });
                  }
                }}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                <option value="">{isLoadingModels ? "Loading models" : "Select model"}</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </div>

            <div className="console-field playground-field">
              <label htmlFor="playground-prompt">4. Prompt</label>
              <textarea
                id="playground-prompt"
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>

            <div className="console-field playground-field">
              <label htmlFor="playground-system-prompt">5. System Prompt (optional)</label>
              <textarea
                id="playground-system-prompt"
                rows={3}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </div>

            <fieldset className="playground-params">
              <legend>6. Basic parameters</legend>
              <div className="playground-param-grid">
                <div className="console-field">
                  <label htmlFor="playground-temperature">Temperature</label>
                  <input
                    id="playground-temperature"
                    inputMode="decimal"
                    max="2"
                    min="0"
                    step="0.1"
                    type="number"
                    value={temperature}
                    onChange={(event) => setTemperature(event.target.value)}
                  />
                </div>
                <div className="console-field">
                  <label htmlFor="playground-top-p">Top P</label>
                  <input
                    id="playground-top-p"
                    inputMode="decimal"
                    max="1"
                    min="0"
                    step="0.1"
                    type="number"
                    value={topP}
                    onChange={(event) => setTopP(event.target.value)}
                  />
                </div>
                <div className="console-field">
                  <label htmlFor="playground-max-tokens">Max Tokens</label>
                  <input
                    id="playground-max-tokens"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    type="number"
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                  />
                </div>
                <div className="console-field">
                  <label htmlFor="playground-stream">Stream</label>
                  <select
                    id="playground-stream"
                    value={streamMode}
                    onChange={(event) => setStreamMode(event.target.value === "on" ? "on" : "off")}
                  >
                    <option value="off">Off</option>
                    <option value="on">On</option>
                  </select>
                </div>
              </div>
            </fieldset>

            <div className="console-actions playground-actions">
              <button type="button" className="secondary-button" onClick={clearPlayground}>
                <span>Clear</span>
              </button>
              <button type="submit" disabled={isSending}>
                <span>{isSending ? "Sending" : "Send"}</span>
              </button>
            </div>
          </div>
        </form>

        <div className="playground-result-column">
          <section
            className="playground-card playground-response-card"
            aria-label="Response preview"
          >
            <div className="playground-card-head">
              <h2 className="playground-card-title">Response preview</h2>
              <span className={`playground-status-pill playground-status-pill--${statusTone}`}>
                {statusLabel}
              </span>
            </div>
            <div className="playground-response-box" role="status">
              {result ? (
                <>
                  <p className="playground-response-provider">
                    {providerModelLabel} (from Gateway)
                  </p>
                  <pre>{result.responseText}</pre>
                </>
              ) : (
                <p>{status}</p>
              )}
            </div>
          </section>

          <section className="playground-card" aria-label="Request and routing details">
            <h2 className="playground-card-title">Request and routing details</h2>
            <dl className="playground-detail-grid">
              <div>
                <dt>Request ID</dt>
                <dd className="mono">{result?.requestId ?? "—"}</dd>
              </div>
              <div>
                <dt>Provider / Model</dt>
                <dd>{providerModelLabel}</dd>
              </div>
              <div>
                <dt>Strategy</dt>
                <dd>{formatStrategy(detail?.routePolicyStrategy)}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>{formatTokens(displayTokens)}</dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>{formatCost(detail?.totalCostUsd ?? null)}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{formatLatency(detail?.latencyMs ?? null)}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </section>
  );
}

function buildPlaygroundRequestBody(protocol: PlaygroundProtocol, input: PlaygroundRequestInput) {
  if (protocol === "responses") {
    return buildPlaygroundResponsesRequest(input);
  }
  if (protocol === "messages") {
    return buildPlaygroundMessagesRequest(input);
  }
  return buildPlaygroundChatRequest(input);
}

function createPlaygroundRequestId(): string {
  return `playground_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function fetchPlaygroundRequestDetail(
  requestId: string,
): Promise<PlaygroundRequestDetail | null> {
  const response = await fetch(
    `/api/playground/result?requestId=${encodeURIComponent(requestId)}`,
    {
      cache: "no-store",
    },
  ).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  return readPlaygroundRequestDetail(body);
}

function formatCost(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "—";
  }
  return `$${numeric.toFixed(numeric > 0 && numeric < 0.0001 ? 8 : 4)}`;
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(2)}s`;
}

function formatStrategy(value: string | null | undefined): string {
  return value ? value.replaceAll("_", " ") : "—";
}

function formatTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function readPlaygroundEndpointPath(protocol: PlaygroundProtocol): string {
  if (protocol === "responses") {
    return "/v1/responses";
  }
  if (protocol === "messages") {
    return "/v1/messages";
  }
  return "/v1/chat/completions";
}

async function readPlaygroundStreamBody(
  response: Response,
  onText: (text: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await response.text().catch(() => "");
    const text = readPlaygroundStreamResponseText(body);
    onText(text);
    return text;
  }

  const decoder = new TextDecoder();
  let body = "";
  let currentText = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    body += decoder.decode(value, { stream: true });
    const nextText = readPlaygroundStreamResponseText(body);
    if (nextText !== "No response text" && nextText !== currentText) {
      currentText = nextText;
      onText(nextText);
    }
  }

  body += decoder.decode();
  const finalText = readPlaygroundStreamResponseText(body);
  onText(finalText);
  return finalText;
}

function readPlaygroundRequestDetail(body: unknown): PlaygroundRequestDetail | null {
  if (!isRecord(body) || !isRecord(body.detail)) {
    return null;
  }
  const detail = body.detail;
  const requestId = readString(detail.requestId);
  if (!requestId) {
    return null;
  }
  return {
    latencyMs: readNumber(detail.latencyMs),
    providerDisplayName: readString(detail.providerDisplayName),
    providerKey: readString(detail.providerKey),
    providerModelDisplayName: readString(detail.providerModelDisplayName),
    providerModelName: readString(detail.providerModelName),
    requestId,
    routePolicyStrategy: readString(detail.routePolicyStrategy),
    status: readString(detail.status),
    totalCostUsd: readString(detail.totalCostUsd),
    totalTokens: readNumber(detail.totalTokens),
    virtualModelName: readString(detail.virtualModelName),
  };
}

function readPlaygroundRequestParams(input: {
  maxTokens: string;
  prompt: string;
  stream: "off" | "on";
  systemPrompt: string;
  temperature: string;
  topP: string;
}): Omit<PlaygroundRequestInput, "model"> {
  const maxTokens = readOptionalPlaygroundNumber(input.maxTokens);
  return {
    ...(maxTokens === undefined ? {} : { maxTokens: Math.max(1, Math.trunc(maxTokens)) }),
    prompt: input.prompt,
    stream: input.stream === "on",
    systemPrompt: input.systemPrompt,
    temperature: readOptionalPlaygroundNumber(input.temperature),
    topP: readOptionalPlaygroundNumber(input.topP),
  };
}

function readPlaygroundResponseTokenCount(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.usage)) {
    return null;
  }
  const totalTokens = readNumber(body.usage.total_tokens);
  if (totalTokens !== null) {
    return totalTokens;
  }
  const inputTokens = readNumber(body.usage.prompt_tokens) ?? readNumber(body.usage.input_tokens);
  const outputTokens =
    readNumber(body.usage.completion_tokens) ?? readNumber(body.usage.output_tokens);
  return inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
}

function readProviderModelLabel(result: PlaygroundResult | null, fallbackModel: string): string {
  const detail = result?.detail;
  const provider = detail?.providerDisplayName ?? detail?.providerKey;
  const model = detail?.providerModelDisplayName ?? detail?.providerModelName ?? fallbackModel;
  if (provider && model) {
    return `${provider} / ${model}`;
  }
  return model || "—";
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

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
