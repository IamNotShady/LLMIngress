import { randomUUID } from "node:crypto";
import {
  type GatewayRequestActivityProtocol,
  type GatewayRequestActivityRoute,
  recordCompletedGatewayRequestActivity,
} from "@llmingress/gateway-runtime/gateway-activity-recorder";
import {
  type GatewayBudgetSettlement,
  recordGatewayBudgetUsage,
} from "@llmingress/gateway-runtime/gateway-api-key-limits";
import type { ApiKeyRequestLoggingMode } from "@llmingress/gateway-runtime/gateway-auth";
import { runGatewayBackgroundTask } from "@llmingress/gateway-runtime/gateway-background-tasks";
import {
  captureGatewayPayloadValue,
  createGatewayBoundedPayloadAccumulator,
  type GatewayCapturedPayload,
} from "@llmingress/gateway-runtime/gateway-payload-capture";
import type { GatewayRequestMetadata } from "@llmingress/gateway-runtime/gateway-request-metadata";
import { wrapProviderStreamWithActivityCompletion } from "@llmingress/gateway-runtime/gateway-stream-pipeline";
import type { GatewayStreamingResult } from "@llmingress/gateway-runtime/gateway-streaming";
import {
  buildGatewayProviderUsageResponseBody,
  createGatewayStreamingUsageCollector,
} from "@llmingress/gateway-runtime/gateway-usage-collector";
import type { GatewayUsageCostDetails } from "@llmingress/gateway-runtime/gateway-usage-recorder";
import type { FastifyBaseLogger } from "fastify";

export type GatewayJsonEndpointResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  budgetSettlement?: GatewayBudgetSettlement;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayRequestRecorder = {
  recordActivity: typeof recordCompletedGatewayRequestActivity;
};

export const defaultGatewayRequestRecorder: GatewayRequestRecorder = {
  recordActivity: recordCompletedGatewayRequestActivity,
};

function runRecordingTask(input: {
  activityId?: string;
  logger: FastifyBaseLogger;
  message: string;
  name: string;
  requestId: string;
  task: () => Promise<void>;
}): void {
  runGatewayBackgroundTask({
    logger: input.logger,
    message: input.message,
    metadata: {
      ...(input.activityId ? { activityId: input.activityId } : {}),
      requestId: input.requestId,
    },
    name: input.name,
    task: input.task,
  });
}

export async function executeRecordedGatewayJsonRequest(input: {
  apiKeyId: string;
  apiKeyPrefix: string;
  /** The body as the client sent it, kept only for a key that logs in full. */
  clientRequestBody: unknown;
  execute: () => Promise<GatewayJsonEndpointResponse>;
  logger: FastifyBaseLogger;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  recorder?: GatewayRequestRecorder;
  requestId: string;
  requestLoggingMode: ApiKeyRequestLoggingMode;
  virtualModelId: string;
}): Promise<GatewayJsonEndpointResponse> {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  const activity = startActivity();
  const response = await input.execute();
  const usageCost = response.usageCost;

  if (response.statusCode < 400 && usageCost) {
    scheduleBudgetUsage({
      apiKeyId: input.apiKeyId,
      budgetSettlement: response.budgetSettlement,
      input,
      message: "gateway budget usage recording failed",
      usageCost,
    });
  }

  scheduleRecordActivity({
    activity,
    input,
    payload: captureBothBodies(input, response.body),
    recorder,
    requestMetadata: response.requestMetadata,
    responseBody: response.body,
    route: response.activity,
    statusCode: response.statusCode,
    stream: false,
    usageCost: response.statusCode < 400 ? usageCost : undefined,
  });

  return response;
}

export async function executeRecordedGatewayStreamingRequest(input: {
  apiKeyId: string;
  apiKeyPrefix: string;
  /** The body as the client sent it, kept only for a key that logs in full. */
  clientRequestBody: unknown;
  execute: () => Promise<GatewayStreamingResult>;
  logger: FastifyBaseLogger;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  recorder?: GatewayRequestRecorder;
  requestId: string;
  requestLoggingMode: ApiKeyRequestLoggingMode;
  virtualModelId: string;
}): Promise<GatewayStreamingResult> {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  const activity = startActivity();
  const response = await input.execute();
  if (!response.ok) {
    scheduleRecordActivity({
      activity,
      input,
      payload: captureBothBodies(input, response.body),
      recorder,
      requestMetadata: response.requestMetadata,
      responseBody: response.body,
      route: response.activity,
      statusCode: response.statusCode,
      stream: true,
    });
    return response;
  }

  const usageCollector = createGatewayStreamingUsageCollector();
  // The events as the client receives them: a stream has no parsed body to
  // capture afterwards, and one that fails or is abandoned mid-flight is still
  // what this key asked to keep.
  const streamedResponse =
    input.requestLoggingMode === "full" ? createGatewayBoundedPayloadAccumulator() : undefined;
  return {
    ...response,
    body: wrapProviderStreamWithActivityCompletion(response.body, {
      collectChunk: (chunk) => {
        usageCollector.collect(chunk);
        streamedResponse?.append(chunk);
      },
      completeActivity: async ({ statusCode }) => {
        const providerUsage = usageCollector.readUsage();
        const usageCost = response.usageCost;
        const usageCostWithProviderUsage =
          usageCost && providerUsage ? { ...usageCost, providerUsage } : usageCost;

        if (statusCode < 400 && usageCostWithProviderUsage) {
          scheduleBudgetUsage({
            apiKeyId: input.apiKeyId,
            budgetSettlement: response.budgetSettlement,
            input,
            message: "gateway stream budget usage recording failed",
            usageCost: usageCostWithProviderUsage,
          });
        }

        scheduleRecordActivity({
          activity,
          input,
          payload: streamedResponse
            ? {
                requestBody: captureGatewayPayloadValue(input.clientRequestBody),
                responseBody: streamedResponse.read(),
              }
            : undefined,
          recorder,
          requestMetadata: response.requestMetadata,
          responseBody: providerUsage ? buildGatewayProviderUsageResponseBody(providerUsage) : {},
          route: response.activity,
          statusCode,
          stream: true,
          usageCost: statusCode < 400 ? usageCostWithProviderUsage : undefined,
        });
      },
      statusCode: response.statusCode,
    }),
  };
}

function startActivity(): { id: string; startedAt: Date } {
  return { id: randomUUID(), startedAt: new Date() };
}

/**
 * Both bodies of a request that answered in one piece, for a key that logs in
 * full. Every other key captures nothing, which is what a null payload means.
 */
function captureBothBodies(
  input: { clientRequestBody: unknown; requestLoggingMode: ApiKeyRequestLoggingMode },
  responseBody: unknown,
): GatewayCapturedPayload | undefined {
  if (input.requestLoggingMode !== "full") {
    return undefined;
  }

  return {
    requestBody: captureGatewayPayloadValue(input.clientRequestBody),
    responseBody: captureGatewayPayloadValue(responseBody),
  };
}

function scheduleRecordActivity(input: {
  activity: { id: string; startedAt: Date };
  input: {
    apiKeyId: string;
    apiKeyPrefix: string;
    logger: FastifyBaseLogger;
    model: string;
    protocol: GatewayRequestActivityProtocol;
    requestId: string;
    virtualModelId: string;
  };
  payload?: GatewayCapturedPayload;
  requestMetadata?: GatewayRequestMetadata;
  recorder: GatewayRequestRecorder;
  responseBody: unknown;
  route?: GatewayRequestActivityRoute;
  statusCode: number;
  stream: boolean;
  usageCost?: GatewayUsageCostDetails;
}): void {
  runRecordingTask({
    activityId: input.activity.id,
    logger: input.input.logger,
    message: "gateway activity recording failed",
    name: "gateway.activity",
    requestId: input.input.requestId,
    task: () =>
      input.recorder.recordActivity({
        activityId: input.activity.id,
        apiKeyPrefix: input.input.apiKeyPrefix,
        apiKeyId: input.input.apiKeyId,
        model: input.input.model,
        payload: input.payload,
        protocol: input.input.protocol,
        requestId: input.input.requestId,
        requestMetadata: input.requestMetadata,
        responseBody: input.responseBody,
        route: input.route,
        startedAt: input.activity.startedAt,
        statusCode: input.statusCode,
        stream: input.stream,
        usageCost: input.usageCost,
        virtualModelId: input.input.virtualModelId,
      }),
  });
}

function scheduleBudgetUsage(input: {
  apiKeyId: string;
  budgetSettlement: GatewayBudgetSettlement | undefined;
  input: {
    logger: FastifyBaseLogger;
    requestId: string;
  };
  message: string;
  usageCost: GatewayUsageCostDetails;
}): void {
  runRecordingTask({
    logger: input.input.logger,
    message: input.message,
    name: "gateway.budget",
    requestId: input.input.requestId,
    task: () =>
      recordGatewayBudgetUsage({
        apiKeyId: input.apiKeyId,
        budgetSettlement: input.budgetSettlement,
        requestId: input.input.requestId,
        usageCost: input.usageCost,
      }),
  });
}
