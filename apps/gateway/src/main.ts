import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import { assertPostgresDatabaseConfigured, closePostgresPools } from "@llmingress/db/client";
import type {
  GatewayRequestActivityProtocol,
  GatewayRequestActivityRoute,
} from "@llmingress/gateway-runtime/gateway-activity-recorder";
import { authenticateGatewayRequest } from "@llmingress/gateway-runtime/gateway-auth";
import { gatewayBackgroundTasks } from "@llmingress/gateway-runtime/gateway-background-tasks";
import { executeGatewayOpenAIChatCompletion } from "@llmingress/gateway-runtime/gateway-chat-completions";
import {
  createGatewayConfigRuntime,
  type GatewayConfigRuntime,
  type GatewayConfigSnapshot,
} from "@llmingress/gateway-runtime/gateway-config-reload";
import {
  gatewayBodyLimitBytes,
  gatewayConfigNotifications,
  gatewayConfigReconcileIntervalMs,
  gatewayListenHost,
  gatewayReadinessTimeoutMs,
  gatewayShutdownDrainMs,
} from "@llmingress/gateway-runtime/gateway-env";
import { gatewayRequestIdHeader } from "@llmingress/gateway-runtime/gateway-error-mapping";
import { readGatewayProviderRequestHeaders } from "@llmingress/gateway-runtime/gateway-header-passthrough";
import { readGatewayHealthStatus } from "@llmingress/gateway-runtime/gateway-health";
import { executeGatewayAnthropicMessages } from "@llmingress/gateway-runtime/gateway-messages";
import {
  type GatewayRequestMetadata,
  gatewayRequestMetadataHeader,
  serializeGatewayRequestMetadata,
  shouldExposeGatewayRequestMetadata,
} from "@llmingress/gateway-runtime/gateway-request-metadata";
import { executeGatewayOpenAIResponse } from "@llmingress/gateway-runtime/gateway-responses";
import {
  executeGatewayStreamingRequest,
  type GatewayStreamingProtocol,
  type GatewayStreamingResult,
  readGatewayStreamingFlag,
} from "@llmingress/gateway-runtime/gateway-streaming";
import type { GatewayUsageCostDetails } from "@llmingress/gateway-runtime/gateway-usage-recorder";
import {
  type GatewayVirtualModel,
  listAllowedGatewayVirtualModels,
  readRequestedModelName,
  resolveGatewayVirtualModelRequest,
} from "@llmingress/gateway-runtime/gateway-virtual-model-access";
import { createLogger, createPinoLoggerOptions } from "@llmingress/logging";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from "fastify";
import { gatewayCorsHeaders, mergeAccessControlExposeHeaders } from "./cors.js";
import {
  executeRecordedGatewayJsonRequest,
  executeRecordedGatewayStreamingRequest,
} from "./request-recording.js";

const logger = createLogger("gateway");

type CreateGatewayAppOptions = {
  configRuntime?: GatewayConfigRuntime;
};

type GatewayJsonEndpointExecutionInput = {
  apiKeyId: string;
  limitsEnabled: boolean;
  providerRequestHeaders: Record<string, string>;
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
    logger: createPinoLoggerOptions(),
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

  app.get("/health/live", async () => {
    return { service: "gateway", status: "ok" };
  });

  const readinessHandler = async (_request: unknown, reply: FastifyReply) => {
    const health = await readGatewayHealthStatus({
      configRuntime: options.configRuntime,
      timeoutMs: gatewayReadinessTimeoutMs(),
    });
    return reply.code(health.statusCode).send(health.body);
  };
  app.get("/health", readinessHandler);
  app.get("/health/ready", readinessHandler);

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
      apiKeyId: auth.apiKey.id,
    });

    writeGatewayRequestIdHeader(reply, auth.requestId);
    return reply.send({
      data: allowedVirtualModels.map((virtualModel) => ({
        id: virtualModel.name,
        object: "model",
      })),
      object: "list",
      requestId: auth.requestId,
    });
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
  });

  return app;
}

export async function startGateway() {
  const config = loadBootstrapRuntimeConfig();
  assertPostgresDatabaseConfigured();
  const configRuntime = createGatewayConfigRuntime({
    enableNotifications: gatewayConfigNotifications(),
    reconcileIntervalMs: gatewayConfigReconcileIntervalMs(),
  });
  await configRuntime.start();

  const app = createGatewayApp({ configRuntime });

  await app.listen({
    host: gatewayListenHost(),
    port: config.gatewayPort,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    let exitCode = 0;
    try {
      await app.close();
      const drainResult = await gatewayBackgroundTasks.drain({
        timeoutMs: gatewayShutdownDrainMs(),
      });
      if (drainResult.timedOut) {
        exitCode = 1;
        logger.error({ pending: drainResult.pending }, "gateway background task drain timed out");
      }
      await closePostgresPools();
    } catch (error) {
      exitCode = 1;
      logger.error({ err: error }, "gateway shutdown failed");
    }

    process.exit(exitCode);
  };
  process.once("SIGTERM", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "gateway shutdown failed");
      process.exit(1);
    });
  });
  process.once("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, "gateway shutdown failed");
      process.exit(1);
    });
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
    const providerRequestHeaders = readGatewayProviderRequestHeaders(request.headers);

    const allowedVirtualModels = await listAllowedGatewayVirtualModels({
      apiKeyId: auth.apiKey.id,
    });
    const virtualModelAccess = resolveGatewayVirtualModelRequest({
      allowedVirtualModels,
      defaultVirtualModelId: auth.apiKey.defaultVirtualModelId,
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

    logGatewayApiKeyRequest(request.log, {
      apiKeyId: auth.apiKey.apiKeyId,
      apiKeyPrefix: auth.apiKey.keyPrefix,
      method: request.method,
      protocol: endpoint.protocol,
      requestId: auth.requestId,
      url: request.url,
      virtualModelName: virtualModelAccess.virtualModel.name,
    });

    const streamingProtocol = endpoint.streamingProtocol;
    if (streamingProtocol && readGatewayStreamingFlag(request.body)) {
      return sendGatewayStreamingResponse(
        reply,
        await executeRecordedGatewayStreamingRequest({
          apiKeyId: auth.apiKey.id,
          apiKeyPrefix: auth.apiKey.keyPrefix,
          execute: () =>
            executeGatewayStreamingRequest({
              apiKeyId: auth.apiKey.id,
              limitsEnabled: auth.apiKey.limitsEnabled,
              protocol: streamingProtocol,
              providerRequestHeaders,
              requestBody: request.body,
              requestId: auth.requestId,
              snapshot: requireGatewayConfigSnapshot(options),
              virtualModel: virtualModelAccess.virtualModel,
            }),
          logger: request.log,
          model: virtualModelAccess.virtualModel.name,
          protocol: endpoint.protocol,
          requestId: auth.requestId,
          virtualModelId: virtualModelAccess.virtualModel.id,
        }),
        auth.requestId,
      );
    }

    const response = await executeRecordedGatewayJsonRequest({
      apiKeyId: auth.apiKey.id,
      apiKeyPrefix: auth.apiKey.keyPrefix,
      execute: () =>
        endpoint.execute({
          apiKeyId: auth.apiKey.id,
          limitsEnabled: auth.apiKey.limitsEnabled,
          providerRequestHeaders,
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      logger: request.log,
      model: virtualModelAccess.virtualModel.name,
      protocol: endpoint.protocol,
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
  reply.header("x-llmingress-request-id", requestId);
}

function writeGatewayResponseHeaders(
  reply: FastifyReply,
  headers: Record<string, string> | undefined,
) {
  if (!headers) {
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "access-control-expose-headers") {
      const gatewayValue = reply.getHeader(name);
      reply.header(
        name,
        mergeAccessControlExposeHeaders(
          value,
          typeof gatewayValue === "string" ? gatewayValue : undefined,
        ),
      );
      continue;
    }
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

type GatewayApiKeyRequestLogInput = {
  apiKeyId: string;
  apiKeyPrefix: string;
  method: string;
  protocol: GatewayRequestActivityProtocol;
  requestId: string;
  url: string;
  virtualModelName: string;
};

export function buildGatewayApiKeyRequestLog(input: GatewayApiKeyRequestLogInput) {
  return {
    apiKeyId: input.apiKeyId,
    apiKeyPrefix: input.apiKeyPrefix,
    method: input.method,
    protocol: input.protocol,
    requestId: input.requestId,
    url: input.url,
    virtualModel: input.virtualModelName,
  };
}

function logGatewayApiKeyRequest(logger: FastifyBaseLogger, input: GatewayApiKeyRequestLogInput) {
  const payload = buildGatewayApiKeyRequestLog(input);
  logger.info(payload, "gateway api key request");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error: unknown) => {
    logger.error({ err: error }, "gateway startup failed");
    process.exit(1);
  });
}
