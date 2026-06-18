import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import Fastify, { type FastifyReply } from "fastify";
import {
  completeGatewayRequestActivity,
  createGatewayRequestActivity,
  type GatewayRequestActivityProtocol,
  type GatewayRequestActivityRoute,
  readGatewayActivityError,
} from "./activity-recorder.js";
import { authenticateGatewayRequest } from "./auth.js";
import { executeGatewayOpenAIChatCompletion } from "./chat-completions.js";
import { createGatewayConfigRuntime, type GatewayConfigRuntime } from "./config-reload.js";
import { gatewayCorsHeaders } from "./cors.js";
import { executeGatewayOpenAIEmbeddings } from "./embeddings.js";
import { gatewayRequestIdHeader } from "./error-mapping.js";
import { executeGatewayAnthropicMessages } from "./messages.js";
import { getPrometheusMetricsDocument } from "./metrics.js";
import {
  type GatewayRequestMetadata,
  gatewayRequestMetadataHeader,
  serializeGatewayRequestMetadata,
  shouldExposeGatewayRequestMetadata,
} from "./request-metadata.js";
import { executeGatewayOpenAIResponse } from "./responses.js";
import {
  executeGatewayStreamingRequest,
  type GatewayStreamingResult,
  readGatewayStreamingFlag,
  wrapProviderStreamWithActivityCompletion,
} from "./streaming.js";
import { recordGatewayRequestTrace } from "./tracing.js";
import {
  type GatewayUsageCostDetails,
  recordGatewayUsageCostAndSavings,
} from "./usage-recorder.js";
import {
  listAllowedGatewayVirtualModels,
  readRequestedModelName,
  resolveGatewayVirtualModelRequest,
} from "./virtual-model-access.js";

type CreateGatewayAppOptions = {
  configRuntime?: GatewayConfigRuntime;
  databaseUrl?: string;
};

export function createGatewayApp(options: CreateGatewayAppOptions = {}) {
  const app = Fastify({
    logger: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    const corsHeaders = gatewayCorsHeaders(firstRequestHeaderValue(request.headers.origin));
    for (const [name, value] of Object.entries(corsHeaders)) {
      reply.header(name, value);
    }

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.get("/health", async () => {
    const snapshot = options.configRuntime?.getSnapshot();

    return {
      configVersion: snapshot?.version ?? null,
      providerCount: snapshot?.providers.length ?? 0,
      service: "gateway",
      status: "ok",
    };
  });

  app.get("/metrics", async (_request, reply) => {
    const document = await getPrometheusMetricsDocument({
      databaseUrl: requireGatewayDatabaseUrl(options),
    });
    return reply.header("content-type", document.contentType).send(document.body);
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentApiKeyId: auth.agentApiKey.id,
      databaseUrl,
    });
    const virtualModelAccess = resolveGatewayVirtualModelRequest({
      allowedVirtualModels,
      defaultVirtualModelId: auth.agentApiKey.defaultVirtualModelId,
      requestedModelName: readRequestedModelName(request.body),
      requestId: auth.requestId,
    });
    if (!virtualModelAccess.ok) {
      return sendGatewayErrorResponse(
        reply,
        virtualModelAccess.statusCode,
        virtualModelAccess.body,
      );
    }

    if (readGatewayStreamingFlag(request.body)) {
      return sendGatewayStreamingResponse(
        reply,
        await executeRecordedGatewayStreamingRequest({
          agentApiKeyId: auth.agentApiKey.id,
          agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
          databaseUrl,
          execute: () =>
            executeGatewayStreamingRequest({
              agentApiKeyId: auth.agentApiKey.id,
              databaseUrl,
              protocol: "chat_completions",
              requestBody: request.body,
              requestId: auth.requestId,
              snapshot: requireGatewayConfigSnapshot(options),
              virtualModel: virtualModelAccess.virtualModel,
            }),
          model: virtualModelAccess.virtualModel.name,
          protocol: "chat_completions",
          requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
        auth.requestId,
      );
    }

    const chatCompletion = await executeRecordedGatewayJsonRequest({
      agentApiKeyId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      databaseUrl,
      execute: (requestActivityId) =>
        executeGatewayOpenAIChatCompletion({
          agentApiKeyId: auth.agentApiKey.id,
          databaseUrl,
          requestActivityId,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      model: virtualModelAccess.virtualModel.name,
      protocol: "chat_completions",
      requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, chatCompletion, auth.requestId);
  });

  app.get("/v1/models", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentApiKeyId: auth.agentApiKey.id,
      databaseUrl,
    });

    return reply.header(gatewayRequestIdHeader, auth.requestId).send({
      data: allowedVirtualModels.map((virtualModel) => ({
        id: virtualModel.name,
        object: "model",
      })),
      object: "list",
      requestId: auth.requestId,
    });
  });

  app.post("/v1/embeddings", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentApiKeyId: auth.agentApiKey.id,
      databaseUrl,
    });
    const virtualModelAccess = resolveGatewayVirtualModelRequest({
      allowedVirtualModels,
      defaultVirtualModelId: auth.agentApiKey.defaultVirtualModelId,
      requestedModelName: readRequestedModelName(request.body),
      requestId: auth.requestId,
    });
    if (!virtualModelAccess.ok) {
      return sendGatewayErrorResponse(
        reply,
        virtualModelAccess.statusCode,
        virtualModelAccess.body,
      );
    }

    const embeddings = await executeRecordedGatewayJsonRequest({
      agentApiKeyId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      databaseUrl,
      execute: (requestActivityId) =>
        executeGatewayOpenAIEmbeddings({
          agentApiKeyId: auth.agentApiKey.id,
          databaseUrl,
          requestActivityId,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      model: virtualModelAccess.virtualModel.name,
      protocol: "embeddings",
      requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, embeddings, auth.requestId);
  });

  app.post("/v1/responses", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentApiKeyId: auth.agentApiKey.id,
      databaseUrl,
    });
    const virtualModelAccess = resolveGatewayVirtualModelRequest({
      allowedVirtualModels,
      defaultVirtualModelId: auth.agentApiKey.defaultVirtualModelId,
      requestedModelName: readRequestedModelName(request.body),
      requestId: auth.requestId,
    });
    if (!virtualModelAccess.ok) {
      return sendGatewayErrorResponse(
        reply,
        virtualModelAccess.statusCode,
        virtualModelAccess.body,
      );
    }

    if (readGatewayStreamingFlag(request.body)) {
      return sendGatewayStreamingResponse(
        reply,
        await executeRecordedGatewayStreamingRequest({
          agentApiKeyId: auth.agentApiKey.id,
          agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
          databaseUrl,
          execute: () =>
            executeGatewayStreamingRequest({
              agentApiKeyId: auth.agentApiKey.id,
              databaseUrl,
              protocol: "responses",
              requestBody: request.body,
              requestId: auth.requestId,
              snapshot: requireGatewayConfigSnapshot(options),
              virtualModel: virtualModelAccess.virtualModel,
            }),
          model: virtualModelAccess.virtualModel.name,
          protocol: "responses",
          requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
        auth.requestId,
      );
    }

    const response = await executeRecordedGatewayJsonRequest({
      agentApiKeyId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      databaseUrl,
      execute: (requestActivityId) =>
        executeGatewayOpenAIResponse({
          agentApiKeyId: auth.agentApiKey.id,
          databaseUrl,
          requestActivityId,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      model: virtualModelAccess.virtualModel.name,
      protocol: "responses",
      requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, response, auth.requestId);
  });

  app.post("/v1/messages", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentApiKeyId: auth.agentApiKey.id,
      databaseUrl,
    });
    const virtualModelAccess = resolveGatewayVirtualModelRequest({
      allowedVirtualModels,
      defaultVirtualModelId: auth.agentApiKey.defaultVirtualModelId,
      requestedModelName: readRequestedModelName(request.body),
      requestId: auth.requestId,
    });
    if (!virtualModelAccess.ok) {
      return sendGatewayErrorResponse(
        reply,
        virtualModelAccess.statusCode,
        virtualModelAccess.body,
      );
    }

    if (readGatewayStreamingFlag(request.body)) {
      return sendGatewayStreamingResponse(
        reply,
        await executeRecordedGatewayStreamingRequest({
          agentApiKeyId: auth.agentApiKey.id,
          agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
          databaseUrl,
          execute: () =>
            executeGatewayStreamingRequest({
              agentApiKeyId: auth.agentApiKey.id,
              databaseUrl,
              protocol: "messages",
              requestBody: request.body,
              requestId: auth.requestId,
              snapshot: requireGatewayConfigSnapshot(options),
              virtualModel: virtualModelAccess.virtualModel,
            }),
          model: virtualModelAccess.virtualModel.name,
          protocol: "messages",
          requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
        auth.requestId,
      );
    }

    const message = await executeRecordedGatewayJsonRequest({
      agentApiKeyId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      databaseUrl,
      execute: (requestActivityId) =>
        executeGatewayAnthropicMessages({
          agentApiKeyId: auth.agentApiKey.id,
          databaseUrl,
          requestActivityId,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      model: virtualModelAccess.virtualModel.name,
      protocol: "messages",
      requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, message, auth.requestId);
  });

  app.addHook("onClose", async () => {
    await options.configRuntime?.stop();
  });

  return app;
}

export async function startGateway() {
  const config = loadBootstrapRuntimeConfig();
  const configRuntime = createGatewayConfigRuntime({
    databaseUrl: config.databaseUrl,
    enableNotifications: readBooleanEnv("GATEWAY_CONFIG_NOTIFICATIONS", true),
    gatewayInstanceId: process.env.GATEWAY_INSTANCE_ID?.trim() || "gateway",
    heartbeatIntervalMs: readNonNegativeIntegerEnv("GATEWAY_HEARTBEAT_INTERVAL_MS", 15_000),
    reconcileIntervalMs: readNonNegativeIntegerEnv("GATEWAY_CONFIG_RECONCILE_INTERVAL_MS", 30_000),
  });
  await configRuntime.start();

  const app = createGatewayApp({ configRuntime, databaseUrl: config.databaseUrl });

  await app.listen({
    host: "0.0.0.0",
    port: config.gatewayPort,
  });
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value !== "false";
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function requireGatewayDatabaseUrl(options: CreateGatewayAppOptions): string {
  if (!options.databaseUrl) {
    throw new Error("Gateway API endpoints require databaseUrl.");
  }
  return options.databaseUrl;
}

function requireGatewayConfigSnapshot(options: CreateGatewayAppOptions) {
  const snapshot = options.configRuntime?.getSnapshot();
  if (!snapshot) {
    throw new Error("Gateway API endpoints require configRuntime.");
  }
  return snapshot;
}

function sendGatewayStreamingResponse(
  reply: FastifyReply,
  stream: GatewayStreamingResult,
  requestId: string,
) {
  writeGatewayRequestIdHeader(reply, requestId);
  writeGatewayRequestMetadataDebugHeader(reply, stream.requestMetadata);
  writeGatewayResponseHeaders(reply, stream.headers);
  if (!stream.ok) {
    return reply.code(stream.statusCode).send(stream.body);
  }

  return reply.code(stream.statusCode).header("content-type", stream.contentType).send(stream.body);
}

function sendGatewayJsonResponse(
  reply: FastifyReply,
  response: {
    activity?: GatewayRequestActivityRoute;
    body: unknown;
    headers?: Record<string, string>;
    requestMetadata?: GatewayRequestMetadata;
    statusCode: number;
  },
  requestId: string,
) {
  writeGatewayRequestIdHeader(reply, requestId);
  writeGatewayRequestMetadataDebugHeader(reply, response.requestMetadata);
  writeGatewayResponseHeaders(reply, response.headers);
  return reply.code(response.statusCode).send(response.body);
}

function sendGatewayErrorResponse(
  reply: FastifyReply,
  statusCode: number,
  body: { requestId: string },
) {
  writeGatewayRequestIdHeader(reply, body.requestId);
  return reply.code(statusCode).send(body);
}

function writeGatewayRequestIdHeader(reply: FastifyReply, requestId: string) {
  reply.header(gatewayRequestIdHeader, requestId);
}

function writeGatewayResponseHeaders(
  reply: FastifyReply,
  headers: Record<string, string> | undefined,
) {
  if (!headers) {
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}

function firstRequestHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeGatewayRequestMetadataDebugHeader(
  reply: FastifyReply,
  metadata: GatewayRequestMetadata | undefined,
) {
  if (!metadata || !shouldExposeGatewayRequestMetadata()) {
    return;
  }

  reply.header(gatewayRequestMetadataHeader, serializeGatewayRequestMetadata(metadata));
}

async function executeRecordedGatewayJsonRequest(input: {
  agentApiKeyId: string;
  agentApiKeyPrefix: string;
  databaseUrl: string;
  execute: (requestActivityId: string) => Promise<{
    activity?: GatewayRequestActivityRoute;
    body: unknown;
    headers?: Record<string, string>;
    requestMetadata?: GatewayRequestMetadata;
    statusCode: number;
    usageCost?: GatewayUsageCostDetails;
  }>;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  requestLoggingEnabled: boolean;
  requestId: string;
  virtualModelId: string;
}) {
  const activity = await createGatewayRequestActivity({
    agentApiKeyId: input.agentApiKeyId,
    agentApiKeyPrefix: input.agentApiKeyPrefix,
    databaseUrl: input.databaseUrl,
    model: input.model,
    protocol: input.protocol,
    requestId: input.requestId,
    stream: false,
    virtualModelId: input.virtualModelId,
  });
  const response = await input.execute(activity.id);
  await completeGatewayRequestActivity({
    activityId: activity.id,
    databaseUrl: input.databaseUrl,
    requestLoggingEnabled: input.requestLoggingEnabled,
    requestMetadata: response.requestMetadata,
    responseBody: response.body,
    route: response.activity,
    startedAt: activity.startedAt,
    statusCode: response.statusCode,
  });
  if (response.statusCode < 400 && response.usageCost) {
    await recordGatewayUsageCostAndSavings({
      activityId: activity.id,
      agentApiKeyId: input.agentApiKeyId,
      databaseUrl: input.databaseUrl,
      usageCost: response.usageCost,
      virtualModelId: input.virtualModelId,
    });
  }
  await recordGatewayRequestTrace({
    errorCode: readGatewayActivityError(response.body)?.errorCode ?? null,
    httpStatus: response.statusCode,
    modelId: response.activity?.modelId ?? null,
    protocol: input.protocol,
    providerKey: response.activity?.providerKey ?? null,
    requestId: input.requestId,
    startedAt: activity.startedAt,
    status: response.statusCode < 400 ? "succeeded" : "failed",
  });
  return response;
}

async function executeRecordedGatewayStreamingRequest(input: {
  agentApiKeyId: string;
  agentApiKeyPrefix: string;
  databaseUrl: string;
  execute: () => Promise<GatewayStreamingResult>;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  requestLoggingEnabled: boolean;
  requestId: string;
  virtualModelId: string;
}): Promise<GatewayStreamingResult> {
  const activity = await createGatewayRequestActivity({
    agentApiKeyId: input.agentApiKeyId,
    agentApiKeyPrefix: input.agentApiKeyPrefix,
    databaseUrl: input.databaseUrl,
    model: input.model,
    protocol: input.protocol,
    requestId: input.requestId,
    stream: true,
    virtualModelId: input.virtualModelId,
  });
  const response = await input.execute();
  if (!response.ok) {
    await completeGatewayRequestActivity({
      activityId: activity.id,
      databaseUrl: input.databaseUrl,
      requestLoggingEnabled: input.requestLoggingEnabled,
      requestMetadata: response.requestMetadata,
      responseBody: response.body,
      route: response.activity,
      startedAt: activity.startedAt,
      statusCode: response.statusCode,
    });
    return response;
  }

  return {
    ...response,
    body: wrapProviderStreamWithActivityCompletion(response.body, {
      completeActivity: ({ statusCode }) =>
        completeGatewayRequestActivity({
          activityId: activity.id,
          databaseUrl: input.databaseUrl,
          requestLoggingEnabled: input.requestLoggingEnabled,
          requestMetadata: response.requestMetadata,
          responseBody: {},
          route: response.activity,
          startedAt: activity.startedAt,
          statusCode,
        }),
      statusCode: response.statusCode,
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
