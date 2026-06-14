import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import Fastify, { type FastifyReply } from "fastify";
import {
  completeGatewayRequestActivity,
  createGatewayRequestActivity,
  type GatewayRequestActivityProtocol,
  type GatewayRequestActivityRoute,
} from "./activity-recorder.js";
import { authenticateGatewayRequest } from "./auth.js";
import { executeGatewayOpenAIChatCompletion } from "./chat-completions.js";
import { createGatewayConfigRuntime, type GatewayConfigRuntime } from "./config-reload.js";
import { gatewayCorsHeaders } from "./cors.js";
import { executeGatewayAnthropicMessages } from "./messages.js";
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

  app.post("/v1/chat/completions", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return reply.code(auth.statusCode).send(auth.body);
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
      return reply.code(virtualModelAccess.statusCode).send(virtualModelAccess.body);
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
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
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
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, chatCompletion);
  });

  app.get("/v1/models", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return reply.code(auth.statusCode).send(auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentApiKeyId: auth.agentApiKey.id,
      databaseUrl,
    });

    return {
      data: allowedVirtualModels.map((virtualModel) => ({
        id: virtualModel.name,
        object: "model",
      })),
      object: "list",
      requestId: auth.requestId,
    };
  });

  app.post("/v1/responses", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return reply.code(auth.statusCode).send(auth.body);
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
      return reply.code(virtualModelAccess.statusCode).send(virtualModelAccess.body);
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
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
      );
    }

    const response = await executeRecordedGatewayJsonRequest({
      agentApiKeyId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      databaseUrl,
      execute: () =>
        executeGatewayOpenAIResponse({
          agentApiKeyId: auth.agentApiKey.id,
          databaseUrl,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      model: virtualModelAccess.virtualModel.name,
      protocol: "responses",
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, response);
  });

  app.post("/v1/messages", async (request, reply) => {
    const databaseUrl = requireGatewayDatabaseUrl(options);
    const auth = await authenticateGatewayRequest({
      databaseUrl,
      headers: request.headers,
    });

    if (!auth.ok) {
      return reply.code(auth.statusCode).send(auth.body);
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
      return reply.code(virtualModelAccess.statusCode).send(virtualModelAccess.body);
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
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
      );
    }

    const message = await executeRecordedGatewayJsonRequest({
      agentApiKeyId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      databaseUrl,
      execute: () =>
        executeGatewayAnthropicMessages({
          agentApiKeyId: auth.agentApiKey.id,
          databaseUrl,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      model: virtualModelAccess.virtualModel.name,
      protocol: "messages",
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, message);
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

function sendGatewayStreamingResponse(reply: FastifyReply, stream: GatewayStreamingResult) {
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
) {
  writeGatewayRequestMetadataDebugHeader(reply, response.requestMetadata);
  writeGatewayResponseHeaders(reply, response.headers);
  return reply.code(response.statusCode).send(response.body);
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
  return response;
}

async function executeRecordedGatewayStreamingRequest(input: {
  agentApiKeyId: string;
  agentApiKeyPrefix: string;
  databaseUrl: string;
  execute: () => Promise<GatewayStreamingResult>;
  model: string;
  protocol: GatewayRequestActivityProtocol;
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
