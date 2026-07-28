"use client";

import { useEffect, useState } from "react";
import { ActionButton, Field, SelectInput, TextArea, TextInput } from "../controls";
import { formatCompact, formatCost, formatLatency } from "../format";
import { DetailRow, SectionTitle } from "../layout";
import { Spinner } from "../spinner";
import { announceToast } from "../toast";
import { PLAYGROUND_KEY_HANDOFF } from "./handoff";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  createPlaygroundStreamDecoder,
  formatPlaygroundFetchError,
  type PlaygroundProtocol,
  readOptionalPlaygroundNumber,
  readPlaygroundErrorText,
  readPlaygroundResponseText,
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

type RouteCandidate = {
  attempt: "failed" | "none" | "served" | "skipped";
  candidateOrder: number;
  label: string;
  reasons: string[];
};

type RequestDetail = {
  /**
   * Every candidate the router recorded, and what became of each. Null when the
   * request recorded none — a route with nothing written down is not a route
   * where everything went well, and the trace does not get to say it was.
   */
  routeCandidates?: RouteCandidate[] | null;
  latencyMs: number | null;
  providerDisplayName: string | null;
  providerModelDisplayName: string | null;
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

type ModelListStatus = "idle" | "loading" | "loaded" | "error";

export function Playground({
  gatewayBaseUrl,
  virtualModels,
}: {
  gatewayBaseUrl: string;
  virtualModels: PlaygroundVirtualModel[];
}) {
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState("4096");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(
    "Write a SQL query that finds the top 5 API keys by total cost over the last 7 days.",
  );
  const [protocol, setProtocol] = useState<PlaygroundProtocol>("chat_completions");
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [stream, setStream] = useState("true");
  /** The answer so far, while it is still being written. */
  const [streamText, setStreamText] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a concise coding assistant.");
  const [temperature, setTemperature] = useState("0.7");

  const [grantedModels, setGrantedModels] = useState<string[]>([]);
  const [modelListStatus, setModelListStatus] = useState<ModelListStatus>("idle");
  const selected = virtualModels.find((entry) => entry.name === model);
  const base = gatewayBaseUrl.replace(/\/+$/, "");

  // A key that has just been created arrives here already pasted: it is the one
  // moment its plaintext exists, and asking the operator to copy it back out of
  // a screen they have already left is asking them to lose it.
  useEffect(() => {
    let handed = "";
    try {
      handed = window.sessionStorage.getItem(PLAYGROUND_KEY_HANDOFF) ?? "";
      window.sessionStorage.removeItem(PLAYGROUND_KEY_HANDOFF);
    } catch {
      return;
    }
    if (handed) {
      setApiKey(handed);
    }
  }, []);

  // Which models this key may actually call is the gateway's answer, not the
  // console's: the console can see every virtual model, but a key only reaches
  // the ones it was granted.
  useEffect(() => {
    const secret = apiKey.trim();
    // A missing or changed key cannot keep showing models authorized for no key
    // or for the previous one while the next lookup is pending.
    setGrantedModels([]);
    setModel("");
    if (!secret) {
      setModelListStatus("idle");
      return;
    }
    setModelListStatus("loading");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${base}/v1/models`, {
          headers: { authorization: `Bearer ${secret}` },
        });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setModelListStatus("error");
          return;
        }
        const payload = (await response.json()) as { data?: Array<{ id?: string }> };
        const ids = (payload.data ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => Boolean(id));
        if (!cancelled) {
          setGrantedModels(ids);
          setModel(ids[0] ?? "");
          setModelListStatus("loaded");
        }
      } catch {
        if (!cancelled) {
          setModelListStatus("error");
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKey, base]);

  const loadingModels = modelListStatus === "loading";
  const modelListHint = virtualModelHint(selected, modelListStatus, grantedModels.length);
  const emptyModelOption =
    modelListStatus === "idle"
      ? "paste an API key first"
      : modelListStatus === "loading"
        ? "loading available models…"
        : modelListStatus === "error"
          ? "could not load models for this key"
          : "no virtual models available for this key";
  // Only when the console knows the model's route: a key's model list comes
  // from the gateway and carries no protocol of its own.
  const protocolMismatch = Boolean(
    selected?.endpointProtocol && selected.endpointProtocol !== protocol,
  );

  const send = async () => {
    if (!apiKey.trim()) {
      setStatus("Paste an llmi_ secret first — the console never stores plaintext keys.");
      return;
    }
    setSending(true);
    setStatus(null);
    setResult(null);
    setStreamText("");
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
      // The gateway stamps its own id; x-request-id may be the provider's and
      // would look up nothing in Activity.
      const requestId = response.headers.get("x-llmingress-request-id");
      // A streamed answer is read as it arrives and shown while it is still
      // being written — buffering the whole body first is the same request with
      // none of the point of streaming it.
      const { raw, streamed } =
        input.stream && response.body
          ? await readStream(response.body, setStreamText)
          : { raw: await response.text(), streamed: "" };
      // A stream request can still come back as one JSON body — an error page
      // or a provider that ignored the flag — so the reader falls through
      // rather than showing an empty response. A refusal is read as a refusal:
      // its message is the only thing on screen that says what to change.
      const parsed = safeParse(raw);
      const responseText =
        (response.ok ? null : readPlaygroundErrorText(parsed)) ||
        streamed.trim() ||
        readPlaygroundResponseText(parsed);

      // The gateway records the request asynchronously, so the trace is polled
      // rather than assumed to exist the moment the response lands. The trace
      // is an extra: failing to read it must not lose the answer, which exists
      // nowhere else once this handler returns.
      const detail = requestId ? await readRequestDetail(requestId).catch(() => null) : null;

      setResult({
        detail,
        httpStatus: response.status,
        ok: response.ok,
        requestId,
        responseText,
      });
      // A key the gateway did not accept was never attributed to a key, so it
      // counted against no limit and reached no Activity row.
      const accepted = response.status !== 401 && response.status !== 403;
      announceToast({
        message: response.ok ? "Request sent through the gateway" : "Gateway returned an error",
        meta: accepted
          ? "It counted toward the key's limits and appears in Activity."
          : "The gateway did not accept this key, so nothing was counted or recorded.",
        tone: response.ok ? "green" : "red",
      });
    } catch (error) {
      announceToast({
        message: formatPlaygroundFetchError("sending the request", error),
        tone: "red",
      });
      // A stream that stopped is not a stream: the live pane would otherwise
      // keep saying it is being written for the rest of the session.
      setStreamText("");
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
              className={`flex-1 whitespace-nowrap px-[11px] py-1 text-center font-mono text-13 ${
                index > 0 ? "border-l border-rule" : ""
              } ${entry.value === protocol ? "bg-seg text-segfg" : "text-dim"}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {/* The console knows which endpoint the model is routed to, so it says
            so here rather than letting the gateway refuse the request. */}
        {protocolMismatch ? (
          <p className="mt-2 font-mono text-125 leading-[1.5] text-ambtx">
            {selected?.name} is routed to{" "}
            {ENDPOINT_PATH[selected?.endpointProtocol as PlaygroundProtocol]} — a{" "}
            {ENDPOINT_PATH[protocol]} request for it is refused before it reaches a provider.
          </p>
        ) : null}

        <div className="mt-[14px]">
          <Field
            label="API KEY"
            hint="Sent as the Bearer token for this request only — never stored. Grants, limits and usage of the pasted key apply as usual."
          >
            <TextInput
              type="password"
              aria-label="API key"
              autoComplete="off"
              placeholder="llmi_…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-[14px]">
          <Field
            label="VIRTUAL MODEL"
            hint={modelListHint}
          >
            {loadingModels ? <Spinner className="mb-[5px]" label="Loading models" /> : null}
            <SelectInput
              aria-label="Virtual model"
              disabled={modelListStatus !== "loaded" || grantedModels.length === 0}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {grantedModels.length === 0 ? (
                <option value="">{emptyModelOption}</option>
              ) : (
                grantedModels.map((name) => (
                  <option key={name} value={name}>
                    {name}
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
            size="dialog"
            disabled={sending || !model}
            onClick={() => void send()}
            tone="primary"
            type="button"
          >
            {sending ? "Sending…" : "Send request"}
          </ActionButton>
          {sending ? (
            <Spinner label="Sending the request" />
          ) : (
            <span className="font-mono text-125 text-faint">counts toward key limits & usage</span>
          )}
        </div>
        {status ? (
          <p className="mt-3 rounded-xs border border-ambbd bg-ambbg px-[10px] py-2 font-mono text-125 text-redtx">
            {status}
          </p>
        ) : null}
      </div>

      <div className="py-[18px] pl-6">
        {result === null && streamText ? (
          // The answer while it is still being written. The trace below it is
          // not here yet: the gateway records the request once it finishes.
          <>
            <div className="flex items-center gap-3 font-mono text-13">
              <span className="font-medium text-dim">streaming…</span>
              <span className="text-dim">
                {base}
                {ENDPOINT_PATH[protocol]}
              </span>
            </div>
            <pre
              data-testid="playground-stream"
              className="mt-3 whitespace-pre-wrap rounded-xs border border-rule bg-track px-4 py-[14px] font-mono text-14 leading-[1.65] text-ink"
            >
              {streamText}
            </pre>
          </>
        ) : result === null ? (
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
                        result.detail.providerModelDisplayName ??
                        result.detail.providerModelName ??
                        "unknown model"
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
              <DetailRow
                label="candidates"
                value={
                  result.detail?.routeCandidates
                    ? `${result.detail.routeCandidates.length} recorded — listed below`
                    : "not recorded for this request"
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
            {/* What the response body cannot show: which other candidates the
                policy offered, in order, and what became of each. The router
                does not rule any of them out beforehand — it stops at the first
                that serves — so a candidate with no attempt never got a turn. */}
            {result.detail?.routeCandidates?.length ? (
              <div className="mt-3">
                <div className="font-mono text-115 font-medium tracking-[.08em] text-dim">
                  CANDIDATES
                </div>
                {result.detail.routeCandidates.map((candidate) => (
                  <div
                    key={`${candidate.candidateOrder}-${candidate.label}`}
                    className="mt-1 flex gap-[10px] font-mono text-12 leading-[1.5]"
                  >
                    <span className="flex-none text-faint tabnum">#{candidate.candidateOrder}</span>
                    <span className="min-w-0 flex-1 text-dim">
                      <span className="text-ink">{candidate.label}</span>
                      {` — ${describeCandidateAttempt(candidate)}`}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <p className="mt-3 font-mono text-12 leading-[1.6] text-faint">
              Per-attempt outcomes — which credential was tried, in what order, and how each one
              ended — are recorded on the request itself: open it in Activity for the full timeline.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** What became of one candidate, said without inventing a verdict for it. */
function describeCandidateAttempt(candidate: RouteCandidate): string {
  if (candidate.attempt === "none") {
    return "no attempt was recorded for it";
  }
  const outcome =
    candidate.attempt === "served"
      ? "served the request"
      : candidate.attempt === "skipped"
        ? "skipped"
        : "failed";
  return candidate.reasons.length > 0 ? `${outcome} · ${candidate.reasons.join(" · ")}` : outcome;
}

/** The recorded trace for a request the gateway has just answered. */
function readRequestDetail(requestId: string): Promise<RequestDetail | null> {
  return retryPlaygroundRequestDetail<RequestDetail>(async () => {
    const lookup = await fetch(
      `/api/playground/result?requestId=${encodeURIComponent(requestId)}`,
      {
        headers: { accept: "application/json" },
      },
    );
    if (!lookup.ok) {
      return null;
    }
    const payload = (await lookup.json()) as { detail: RequestDetail | null };
    return payload.detail;
  });
}

/**
 * Reads the body to the end, handing each decoded piece to the page as it is
 * decoded, and keeps the raw text so a body that turned out not to be a stream
 * can still be parsed as one JSON answer.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<{ raw: string; streamed: string }> {
  const reader = body.getReader();
  const bytes = new TextDecoder();
  const frames = createPlaygroundStreamDecoder();
  let raw = "";
  let streamed = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = bytes.decode(value, { stream: true });
    raw += chunk;
    const text = frames.push(chunk);
    if (text) {
      streamed += text;
      onText(streamed);
    }
  }

  // Whatever the decoders were still holding: a multi-byte character split
  // across chunks, and a last frame that never got its newline.
  const trailing = bytes.decode();
  if (trailing) {
    raw += trailing;
    streamed += frames.push(trailing);
  }
  streamed += frames.flush();
  if (streamed) {
    onText(streamed);
  }
  return { raw, streamed };
}

function virtualModelHint(
  model: PlaygroundVirtualModel | undefined,
  status: ModelListStatus,
  modelCount: number,
): string {
  if (status === "idle") {
    return "Paste an API key to list the models it may call.";
  }
  if (status === "loading") {
    return "Asking the gateway which models this key may call…";
  }
  if (status === "error") {
    return "The gateway did not return a model list for this API key.";
  }
  if (modelCount === 0) {
    return "This API key has no Virtual Model grants.";
  }
  if (!model) {
    return "Available to this API key.";
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
