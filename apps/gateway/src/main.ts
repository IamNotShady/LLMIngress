import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { assertPostgresDatabaseConfigured, closePostgresPools } from "@llmingress/db/client";
import type {
  GatewayRequestActivityProtocol,
  GatewayRequestActivityRoute,
} from "@llmingress/db/gateway-activity-recorder";
import { authenticateGatewayRequest } from "@llmingress/db/gateway-auth";
import { executeGatewayOpenAIChatCompletion } from "@llmingress/db/gateway-chat-completions";
import {
  createGatewayConfigRuntime,
  type GatewayConfigRuntime,
  type GatewayConfigSnapshot,
} from "@llmingress/db/gateway-config-reload";
import { executeGatewayOpenAIEmbeddings } from "@llmingress/db/gateway-embeddings";
import {
  gatewayBodyLimitBytes,
  gatewayConfigNotifications,
  gatewayConfigReconcileIntervalMs,
  gatewayHeartbeatIntervalMs,
  gatewayInstanceId,
  gatewayMetricsToken,
} from "@llmingress/db/gateway-env";
import { gatewayRequestIdHeader } from "@llmingress/db/gateway-error-mapping";
import { executeGatewayAnthropicMessages } from "@llmingress/db/gateway-messages";
import { getPrometheusMetricsDocument } from "@llmingress/db/gateway-metrics";
import {
  type GatewayRequestMetadata,
  gatewayRequestMetadataHeader,
  serializeGatewayRequestMetadata,
  shouldExposeGatewayRequestMetadata,
} from "@llmingress/db/gateway-request-metadata";
import { executeGatewayOpenAIResponse } from "@llmingress/db/gateway-responses";
import {
  executeGatewayStreamingRequest,
  type GatewayStreamingProtocol,
  type GatewayStreamingResult,
  readGatewayStreamingFlag,
} from "@llmingress/db/gateway-streaming";
import type { GatewayUsageCostDetails } from "@llmingress/db/gateway-usage-recorder";
import {
  type GatewayVirtualModel,
  listAllowedGatewayVirtualModels,
  readRequestedModelName,
  resolveGatewayVirtualModelRequest,
} from "@llmingress/db/gateway-virtual-model-access";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from "fastify";
import { gatewayCorsHeaders } from "./cors.js";
import {
  executeRecordedGatewayJsonRequest,
  executeRecordedGatewayStreamingRequest,
} from "./request-recording.js";

type CreateGatewayAppOptions = {
  configRuntime?: GatewayConfigRuntime;
};

type GatewayJsonEndpointExecutionInput = {
  agentId: string;
  requestActivityId: string | undefined;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
};

type GatewayJsonEndpointResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

type GatewayJsonEndpointDefinition = {
  execute: (input: GatewayJsonEndpointExecutionInput) => Promise<GatewayJsonEndpointResponse>;
  path: string;
  protocol: GatewayRequestActivityProtocol;
  streamingProtocol?: GatewayStreamingProtocol;
};

export function createGatewayApp(options: CreateGatewayAppOptions = {}) {
  const app = Fastify({
    bodyLimit: gatewayBodyLimitBytes(),
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

  app.get("/metrics", async (request, reply) => {
    const requiredToken = gatewayMetricsToken();
    if (requiredToken) {
      const authorization = firstRequestHeaderValue(request.headers.authorization);
      if (authorization !== `Bearer ${requiredToken}`) {
        return reply.code(401).send({
          error: {
            code: "unauthorized_metrics_access",
            message: "Metrics access requires a valid bearer token.",
          },
        });
      }
    }

    const document = await getPrometheusMetricsDocument({});
    return reply.header("content-type", document.contentType).send(document.body);
  });

  registerGatewayJsonEndpoint(app, options, {
    execute: (input) => executeGatewayOpenAIChatCompletion(input),
    path: "/v1/chat/completions",
    protocol: "chat_completions",
    streamingProtocol: "chat_completions",
  });

  app.get("/v1/models", async (request, reply) => {
    const auth = await authenticateGatewayRequest({
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentId: auth.agentApiKey.id,
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

  registerGatewayJsonEndpoint(app, options, {
    execute: (input) => executeGatewayOpenAIEmbeddings(input),
    path: "/v1/embeddings",
    protocol: "embeddings",
  });

  registerGatewayJsonEndpoint(app, options, {
    execute: (input) => executeGatewayOpenAIResponse(input),
    path: "/v1/responses",
    protocol: "responses",
    streamingProtocol: "responses",
  });

  registerGatewayJsonEndpoint(app, options, {
    execute: (input) => executeGatewayAnthropicMessages(input),
    path: "/v1/messages",
    protocol: "messages",
    streamingProtocol: "messages",
  });

  app.addHook("onClose", async () => {
    await options.configRuntime?.stop();
    await closePostgresPools();
  });

  return app;
}

export async function startGateway() {
  const config = loadBootstrapRuntimeConfig();
  assertPostgresDatabaseConfigured();
  const configRuntime = createGatewayConfigRuntime({
    enableNotifications: gatewayConfigNotifications(),
    gatewayInstanceId: gatewayInstanceId(),
    heartbeatIntervalMs: gatewayHeartbeatIntervalMs(),
    reconcileIntervalMs: gatewayConfigReconcileIntervalMs(),
  });
  await configRuntime.start();

  const app = createGatewayApp({ configRuntime });

  await app.listen({
    host: "0.0.0.0",
    port: config.gatewayPort,
  });
}

function requireGatewayConfigSnapshot(options: CreateGatewayAppOptions) {
  const snapshot = options.configRuntime?.getSnapshot();
  if (!snapshot) {
    throw new Error("Gateway API endpoints require configRuntime.");
  }
  return snapshot;
}

function registerGatewayJsonEndpoint(
  app: FastifyInstance,
  options: CreateGatewayAppOptions,
  endpoint: GatewayJsonEndpointDefinition,
) {
  app.post(endpoint.path, async (request, reply) => {
    const auth = await authenticateGatewayRequest({
      headers: request.headers,
    });

    if (!auth.ok) {
      return sendGatewayErrorResponse(reply, auth.statusCode, auth.body);
    }

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      agentId: auth.agentApiKey.id,
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

    logGatewayAgentRequest(request.log, {
      agentId: auth.agentApiKey.agentId,
      agentKeyPrefix: auth.agentApiKey.keyPrefix,
      method: request.method,
      protocol: endpoint.protocol,
      requestBody: request.body,
      requestId: auth.requestId,
      requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
      url: request.url,
      virtualModelName: virtualModelAccess.virtualModel.name,
    });

    const streamingProtocol = endpoint.streamingProtocol;
    if (streamingProtocol && readGatewayStreamingFlag(request.body)) {
      return sendGatewayStreamingResponse(
        reply,
        await executeRecordedGatewayStreamingRequest({
          agentId: auth.agentApiKey.id,
          agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
          execute: (requestActivityId) =>
            executeGatewayStreamingRequest({
              agentId: auth.agentApiKey.id,
              protocol: streamingProtocol,
              requestActivityId,
              requestBody: request.body,
              requestId: auth.requestId,
              snapshot: requireGatewayConfigSnapshot(options),
              virtualModel: virtualModelAccess.virtualModel,
            }),
          logger: request.log,
          model: virtualModelAccess.virtualModel.name,
          protocol: endpoint.protocol,
          requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
        auth.requestId,
      );
    }

    const response = await executeRecordedGatewayJsonRequest({
      agentId: auth.agentApiKey.id,
      agentApiKeyPrefix: auth.agentApiKey.keyPrefix,
      execute: (requestActivityId) =>
        endpoint.execute({
          agentId: auth.agentApiKey.id,
          requestActivityId,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      logger: request.log,
      model: virtualModelAccess.virtualModel.name,
      protocol: endpoint.protocol,
      requestLoggingEnabled: auth.agentApiKey.requestLoggingEnabled,
      requestId: auth.requestId,
      virtualModelId: virtualModelAccess.virtualModel.id,
    });
    return sendGatewayJsonResponse(reply, response, auth.requestId);
  });
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

type GatewayAgentRequestLogInput = {
  agentId: string;
  agentKeyPrefix: string;
  method: string;
  protocol: GatewayRequestActivityProtocol;
  requestBody: unknown;
  requestId: string;
  requestLoggingEnabled: boolean;
  url: string;
  virtualModelName: string;
};

export function buildGatewayAgentRequestLog(input: GatewayAgentRequestLogInput) {
  if (!input.requestLoggingEnabled) {
    return null;
  }

  return {
    agentId: input.agentId,
    agentKeyPrefix: input.agentKeyPrefix,
    method: input.method,
    protocol: input.protocol,
    requestBody: input.requestBody,
    requestId: input.requestId,
    url: input.url,
    virtualModel: input.virtualModelName,
  };
}

function logGatewayAgentRequest(logger: FastifyBaseLogger, input: GatewayAgentRequestLogInput) {
  const payload = buildGatewayAgentRequestLog(input);
  if (!payload) {
    return;
  }
  logger.info(payload, "gateway agent request");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
