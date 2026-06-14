import { pathToFileURL } from "node:url";
import { loadBootstrapRuntimeConfig } from "@llmingress/config";
import Fastify, { type FastifyReply } from "fastify";
import { authenticateGatewayRequest } from "./auth.js";
import { executeGatewayOpenAIChatCompletion } from "./chat-completions.js";
import { createGatewayConfigRuntime, type GatewayConfigRuntime } from "./config-reload.js";
import { executeGatewayAnthropicMessages } from "./messages.js";
import { executeGatewayOpenAIResponse } from "./responses.js";
import {
  executeGatewayStreamingRequest,
  type GatewayStreamingResult,
  readGatewayStreamingFlag,
} from "./streaming.js";
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
        await executeGatewayStreamingRequest({
          databaseUrl,
          protocol: "chat_completions",
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      );
    }

    const chatCompletion = await executeGatewayOpenAIChatCompletion({
      databaseUrl,
      requestBody: request.body,
      requestId: auth.requestId,
      snapshot: requireGatewayConfigSnapshot(options),
      virtualModel: virtualModelAccess.virtualModel,
    });
    return reply.code(chatCompletion.statusCode).send(chatCompletion.body);
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
        await executeGatewayStreamingRequest({
          databaseUrl,
          protocol: "responses",
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      );
    }

    const response = await executeGatewayOpenAIResponse({
      databaseUrl,
      requestBody: request.body,
      requestId: auth.requestId,
      snapshot: requireGatewayConfigSnapshot(options),
      virtualModel: virtualModelAccess.virtualModel,
    });
    return reply.code(response.statusCode).send(response.body);
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
        await executeGatewayStreamingRequest({
          databaseUrl,
          protocol: "messages",
          requestBody: request.body,
          requestId: auth.requestId,
          snapshot: requireGatewayConfigSnapshot(options),
          virtualModel: virtualModelAccess.virtualModel,
        }),
      );
    }

    const message = await executeGatewayAnthropicMessages({
      databaseUrl,
      requestBody: request.body,
      requestId: auth.requestId,
      snapshot: requireGatewayConfigSnapshot(options),
      virtualModel: virtualModelAccess.virtualModel,
    });
    return reply.code(message.statusCode).send(message.body);
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
  if (!stream.ok) {
    return reply.code(stream.statusCode).send(stream.body);
  }

  return reply.code(stream.statusCode).header("content-type", stream.contentType).send(stream.body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
