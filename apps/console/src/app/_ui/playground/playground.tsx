"use client";

import { useState } from "react";
import { ActionButton, Field, SelectInput, TextArea, TextInput } from "../controls";
import { formatCompact, formatCost, formatLatency } from "../format";
import { DetailRow, SectionTitle } from "../layout";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  formatPlaygroundFetchError,
  type PlaygroundProtocol,
  readOptionalPlaygroundNumber,
  readPlaygroundResponseText,
  readPlaygroundStreamResponseText,
  retryPlaygroundRequestDetail,
} from "./helpers";

const PROTOCOLS: Array<{ label: string; value: PlaygroundProtocol }> = [
  { label: "chat_completions", value: "chat_completions" },
  { label: "messages", value: "messages" },
  { label: "responses", value: "responses" },
];

const ENDPOINT_PATH: Record<PlaygroundProtocol, string> = {
  chat_completions: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
};

export type PlaygroundVirtualModel = {
  endpointProtocol: string | null;
  name: string;
  strategy: string;
};

type RequestDetail = {
  latencyMs: number | null;
  providerDisplayName: string | null;
  providerModelName: string | null;
  requestId: string;
  routePolicyStrategy: string | null;
  status: string | null;
  totalCostUsd: string | null;
  totalTokens: number | null;
  virtualModelName: string | null;
};

type Result = {
  detail: RequestDetail | null;
  httpStatus: number;
  ok: boolean;
  requestId: string | null;
  responseText: string;
};

export function Playground({
  gatewayBaseUrl,
  virtualModels,
}: {
  gatewayBaseUrl: string;
  virtualModels: PlaygroundVirtualModel[];
}) {
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState("4096");
  const [model, setModel] = useState(virtualModels[0]?.name ?? "");
  const [prompt, setPrompt] = useState(
    "Write a SQL query that finds the top 5 API keys by total cost over the last 7 days.",
  );
  const [protocol, setProtocol] = useState<PlaygroundProtocol>("chat_completions");
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [stream, setStream] = useState("true");
  const [systemPrompt, setSystemPrompt] = useState("You are a concise coding assistant.");
  const [temperature, setTemperature] = useState("0.7");
  const [toast, setToast] = useState<string | null>(null);

  const selected = virtualModels.find((entry) => entry.name === model);
  const base = gatewayBaseUrl.replace(/\/+$/, "");

  const send = async () => {
    if (!apiKey.trim()) {
      setStatus("Paste an llmi_ secret first — the console never stores plaintext keys.");
      return;
    }
    setSending(true);
    setStatus(null);
    setResult(null);
    try {
      const input = {
        maxTokens: readOptionalPlaygroundNumber(maxTokens),
        model,
        prompt,
        stream: stream === "true",
        systemPrompt,
        temperature: readOptionalPlaygroundNumber(temperature),
      };
      const body =
        protocol === "messages"
          ? buildPlaygroundMessagesRequest(input)
          : protocol === "responses"
            ? buildPlaygroundResponsesRequest(input)
            : buildPlaygroundChatRequest(input);

      const response = await fetch(`${base}${ENDPOINT_PATH[protocol]}`, {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${apiKey.trim()}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const requestId = response.headers.get("x-request-id");
      const raw = await response.text();
      const responseText = input.stream
        ? readPlaygroundStreamResponseText(raw)
        : readPlaygroundResponseText(safeParse(raw));

      // The gateway records the request asynchronously, so the trace is polled
      // rather than assumed to exist the moment the response lands.
      const detail = requestId
        ? await retryPlaygroundRequestDetail<RequestDetail>(async () => {
            const lookup = await fetch(
              `/api/playground/result?requestId=${encodeURIComponent(requestId)}`,
              { headers: { accept: "application/json" } },
            );
            if (!lookup.ok) {
              return null;
            }
            const payload = (await lookup.json()) as { detail: RequestDetail | null };
            return payload.detail;
          })
        : null;

      setResult({
        detail,
        httpStatus: response.status,
        ok: response.ok,
        requestId,
        responseText,
      });
      setToast(response.ok ? "Request sent through the gateway" : "Gateway returned an error");
      setTimeout(() => setToast(null), 4000);
    } catch (error) {
      setStatus(formatPlaygroundFetchError("sending the request", error));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-4 grid grid-cols-[440px_minmax(0,1fr)] border-t border-hair overflow-x-auto">
      <div className="border-r border-rule py-[18px] pr-6">
        <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">PROTOCOL</div>
        <div className="mt-[6px] flex overflow-hidden rounded-sm border border-rule">
          {PROTOCOLS.map((entry, index) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setProtocol(entry.value)}
              className={`flex-1 px-[11px] py-1 text-center font-mono text-13 ${
                index > 0 ? "border-l border-rule" : ""
              } ${entry.value === protocol ? "bg-seg text-segfg" : "text-dim"}`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="mt-[14px]">
          <Field
            label="API KEY"
            hint="Sent as the Bearer token for this request only — never stored. Grants, limits and usage of the pasted key apply as usual."
          >
            <TextInput
              type="password"
              autoComplete="off"
              placeholder="llmi_…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-[14px]">
          <Field label="VIRTUAL MODEL" hint={virtualModelHint(selected)}>
            <SelectInput value={model} onChange={(event) => setModel(event.target.value)}>
              {virtualModels.length === 0 ? (
                <option value="">no virtual model exists yet</option>
              ) : (
                virtualModels.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))
              )}
            </SelectInput>
          </Field>
        </div>

        <div className="mt-[14px]">
          <Field label="SYSTEM PROMPT">
            <TextArea
              className="h-[60px]"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="USER MESSAGE">
            <TextArea
              className="h-[110px]"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-3">
          <Field label="MAX TOKENS" hint="ceiling for this request">
            <TextInput
              inputMode="numeric"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </Field>
          <Field label="TEMPERATURE" hint="0 is deterministic">
            <TextInput
              inputMode="decimal"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
            />
          </Field>
          <Field label="STREAM" hint="server-sent events">
            <SelectInput value={stream} onChange={(event) => setStream(event.target.value)}>
              <option value="true">true</option>
              <option value="false">false</option>
            </SelectInput>
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <ActionButton
            className="px-4 py-[6px] text-135"
            disabled={sending || virtualModels.length === 0}
            onClick={() => void send()}
            tone="primary"
            type="button"
          >
            {sending ? "Sending…" : "Send request"}
          </ActionButton>
          <span className="font-mono text-125 text-faint">counts toward key limits & usage</span>
        </div>
        {status ? (
          <p className="mt-3 rounded-xs border border-ambbd bg-ambbg px-[10px] py-2 font-mono text-125 text-redtx">
            {status}
          </p>
        ) : null}
      </div>

      <div className="py-[18px] pl-6">
        {result === null ? (
          <p className="font-mono text-13 leading-[1.7] text-dim">
            No request sent yet. The response body and the route it took appear here — the same
            request also shows up in Activity.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 font-mono text-13">
              <span className={result.ok ? "font-medium text-green" : "font-medium text-redtx"}>
                {result.httpStatus} {result.ok ? "OK" : "error"}
              </span>
              <span className="text-dim">
                {base}
                {ENDPOINT_PATH[protocol]}
              </span>
              <span className="ml-auto text-faint">
                {result.detail?.latencyMs === null || result.detail === null
                  ? "latency pending"
                  : formatLatency(result.detail.latencyMs)}
              </span>
            </div>
            <pre className="mt-3 whitespace-pre-wrap rounded-xs border border-rule bg-track px-4 py-[14px] font-mono text-14 leading-[1.65] text-ink">
              {result.responseText}
            </pre>

            <SectionTitle className="mt-4">Route trace</SectionTitle>
            <div className="mt-2 border-t border-hair">
              <DetailRow
                label="resolved virtual model"
                value={
                  result.detail?.virtualModelName ??
                  (result.ok ? "pending — activity not recorded yet" : "not resolved")
                }
              />
              <DetailRow label="strategy" value={result.detail?.routePolicyStrategy ?? "—"} />
              <DetailRow label="endpoint" value={ENDPOINT_PATH[protocol]} />
              <DetailRow
                clip
                label="selected candidate"
                value={
                  result.detail?.providerDisplayName
                    ? `${result.detail.providerDisplayName} · ${
                        result.detail.providerModelName ?? "unknown model"
                      }`
                    : "no candidate recorded"
                }
              />
              <DetailRow
                label="tokens"
                value={
                  result.detail?.totalTokens === null || result.detail === null
                    ? "—"
                    : formatCompact(result.detail.totalTokens)
                }
              />
              <DetailRow label="cost" value={formatCost(result.detail?.totalCostUsd ?? null)} />
              <DetailRow
                label="request id"
                value={
                  result.requestId ? (
                    <a href={`/activity?request=${encodeURIComponent(result.requestId)}`}>
                      {result.requestId} → view in Activity
                    </a>
                  ) : (
                    "not returned by the gateway"
                  )
                }
              />
            </div>
            <p className="mt-3 font-mono text-12 leading-[1.6] text-faint">
              Filtered candidates and per-attempt outcomes are recorded on the request itself — open
              it in Activity for the full route timeline.
            </p>
          </>
        )}
      </div>

      {toast ? (
        <output className="fixed bottom-14 right-6 z-95 flex w-[420px] max-w-[calc(100vw-48px)] items-start gap-3 rounded-sm border border-hair border-l-[3px] border-l-accent bg-btnbg px-[14px] py-[11px] shadow-drawer">
          <span className="min-w-0 flex-1 font-mono text-13 leading-[1.5] text-ink">
            {toast}
            <span className="mt-[3px] block font-mono text-125 text-faint">
              It counted toward the key's limits and appears in Activity.
            </span>
          </span>
        </output>
      ) : null}
    </div>
  );
}

function virtualModelHint(model: PlaygroundVirtualModel | undefined): string {
  if (!model) {
    return "Create a virtual model before sending a request.";
  }
  return `routes over ${model.strategy}${
    model.endpointProtocol ? ` · serves ${model.endpointProtocol}` : ""
  }`;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
