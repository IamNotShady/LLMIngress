import { randomUUID } from "node:crypto";
import {
  type GatewayRequestActivityProtocol,
  type GatewayRequestActivityRoute,
  readGatewayActivityError,
  recordCompletedGatewayRequestActivity,
} from "@llmingress/gateway-runtime/gateway-activity-recorder";
import {
  type GatewayBudgetSettlement,
  recordGatewayBudgetUsage,
} from "@llmingress/gateway-runtime/gateway-agent-limits";
import type { GatewayRequestMetadata } from "@llmingress/gateway-runtime/gateway-request-metadata";
import { wrapProviderStreamWithActivityCompletion } from "@llmingress/gateway-runtime/gateway-stream-pipeline";
import type { GatewayStreamingResult } from "@llmingress/gateway-runtime/gateway-streaming";
import { recordGatewayRequestTrace } from "@llmingress/gateway-runtime/gateway-tracing";
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
  recordTrace: typeof recordGatewayRequestTrace;
};

export const defaultGatewayRequestRecorder: GatewayRequestRecorder = {
  recordActivity: recordCompletedGatewayRequestActivity,
  recordTrace: recordGatewayRequestTrace,
};

function runRecordingTask(input: {
  activityId?: string;
  logger: FastifyBaseLogger;
  message: string;
  requestId: string;
  task: () => Promise<void>;
}): void {
  void input.task().catch((error) => {
    input.logger.error(
      {
        ...(input.activityId ? { activityId: input.activityId } : {}),
        err: error,
        requestId: input.requestId,
      },
      input.message,
    );
  });
}

export async function executeRecordedGatewayJsonRequest(input: {
  agentId: string;
  agentApiKeyPrefix: string;
  execute: () => Promise<GatewayJsonEndpointResponse>;
  logger: FastifyBaseLogger;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  recorder?: GatewayRequestRecorder;
  requestLoggingEnabled: boolean;
  requestId: string;
  virtualModelId: string;
}): Promise<GatewayJsonEndpointResponse> {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  const activity = startActivity();
  const response = await input.execute();
  const usageCost = response.usageCost;

  if (response.statusCode < 400 && usageCost) {
    scheduleBudgetUsage({
      agentId: input.agentId,
      budgetSettlement: response.budgetSettlement,
      input,
      message: "gateway budget usage recording failed",
      usageCost,
    });
  }

  scheduleRecordActivity({
    activity,
    input,
    recorder,
    requestMetadata: response.requestMetadata,
    responseBody: response.body,
    route: response.activity,
    statusCode: response.statusCode,
    stream: false,
    usageCost: response.statusCode < 400 ? usageCost : undefined,
  });

  runRecordingTask({
    logger: input.logger,
    message: "gateway trace recording failed",
    requestId: input.requestId,
    task: () =>
      recorder.recordTrace({
        errorCode: readGatewayActivityError(response.body)?.errorCode ?? null,
        httpStatus: response.statusCode,
        modelId: response.activity?.modelId ?? null,
        protocol: input.protocol,
        providerKey: response.activity?.providerKey ?? null,
        requestId: input.requestId,
        startedAt: activity.startedAt,
        status: response.statusCode < 400 ? "succeeded" : "failed",
      }),
  });

  return response;
}

export async function executeRecordedGatewayStreamingRequest(input: {
  agentId: string;
  agentApiKeyPrefix: string;
  execute: () => Promise<GatewayStreamingResult>;
  logger: FastifyBaseLogger;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  recorder?: GatewayRequestRecorder;
  requestLoggingEnabled: boolean;
  requestId: string;
  virtualModelId: string;
}): Promise<GatewayStreamingResult> {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  const activity = startActivity();
  const response = await input.execute();
  if (!response.ok) {
    scheduleRecordActivity({
      activity,
      input,
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
  return {
    ...response,
    body: wrapProviderStreamWithActivityCompletion(response.body, {
      collectChunk: (chunk) => usageCollector.collect(chunk),
      completeActivity: async ({ statusCode }) => {
        const providerUsage = usageCollector.readUsage();
        const usageCost = response.usageCost;
        const usageCostWithProviderUsage =
          usageCost && providerUsage ? { ...usageCost, providerUsage } : usageCost;

        if (statusCode < 400 && usageCostWithProviderUsage) {
          scheduleBudgetUsage({
            agentId: input.agentId,
            budgetSettlement: response.budgetSettlement,
            input,
            message: "gateway stream budget usage recording failed",
            usageCost: usageCostWithProviderUsage,
          });
        }

        scheduleRecordActivity({
          activity,
          input,
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

function scheduleRecordActivity(input: {
  activity: { id: string; startedAt: Date };
  input: {
    agentId: string;
    agentApiKeyPrefix: string;
    logger: FastifyBaseLogger;
    model: string;
    protocol: GatewayRequestActivityProtocol;
    requestId: string;
    requestLoggingEnabled: boolean;
    virtualModelId: string;
  };
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
    requestId: input.input.requestId,
    task: () =>
      input.recorder.recordActivity({
        activityId: input.activity.id,
        agentApiKeyPrefix: input.input.agentApiKeyPrefix,
        agentId: input.input.agentId,
        model: input.input.model,
        protocol: input.input.protocol,
        requestId: input.input.requestId,
        requestLoggingEnabled: input.input.requestLoggingEnabled,
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
  agentId: string;
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
    requestId: input.input.requestId,
    task: () =>
      recordGatewayBudgetUsage({
        agentId: input.agentId,
        budgetSettlement: input.budgetSettlement,
        requestId: input.input.requestId,
        usageCost: input.usageCost,
      }),
  });
}
