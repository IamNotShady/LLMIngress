import {
  completeGatewayRequestActivity,
  createGatewayRequestActivity,
  type GatewayRequestActivityProtocol,
  type GatewayRequestActivityRoute,
  type GatewayStartedRequestActivity,
  readGatewayActivityError,
} from "@llmingress/db/gateway-activity-recorder";
import type { GatewayRequestMetadata } from "@llmingress/db/gateway-request-metadata";
import {
  settleGatewayStreamBudget,
  wrapProviderStreamWithActivityCompletion,
} from "@llmingress/db/gateway-stream-pipeline";
import type { GatewayStreamingResult } from "@llmingress/db/gateway-streaming";
import { recordGatewayRequestTrace } from "@llmingress/db/gateway-tracing";
import {
  buildGatewayProviderUsageResponseBody,
  createGatewayStreamingUsageCollector,
} from "@llmingress/db/gateway-usage-collector";
import {
  type GatewayUsageCostDetails,
  recordGatewayUsageCostAndSavings,
} from "@llmingress/db/gateway-usage-recorder";
import type { FastifyBaseLogger } from "fastify";

export type GatewayJsonEndpointResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayRequestRecorder = {
  completeActivity: typeof completeGatewayRequestActivity;
  createActivity: typeof createGatewayRequestActivity;
  recordTrace: typeof recordGatewayRequestTrace;
  recordUsageCost: typeof recordGatewayUsageCostAndSavings;
};

export const defaultGatewayRequestRecorder: GatewayRequestRecorder = {
  completeActivity: completeGatewayRequestActivity,
  createActivity: createGatewayRequestActivity,
  recordTrace: recordGatewayRequestTrace,
  recordUsageCost: recordGatewayUsageCostAndSavings,
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
  execute: (requestActivityId: string | undefined) => Promise<GatewayJsonEndpointResponse>;
  logger: FastifyBaseLogger;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  recorder?: GatewayRequestRecorder;
  requestLoggingEnabled: boolean;
  requestId: string;
  virtualModelId: string;
}): Promise<GatewayJsonEndpointResponse> {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  const activity = await createActivity({
    input,
    recorder,
    stream: false,
  });
  const response = await input.execute(activity?.id);
  const startedAt = activity?.startedAt ?? new Date();

  if (activity) {
    scheduleCompleteActivity({
      activity,
      input,
      recorder,
      responseBody: response.body,
      responseMetadata: response.requestMetadata,
      route: response.activity,
      statusCode: response.statusCode,
    });

    const usageCost = response.usageCost;
    if (response.statusCode < 400 && usageCost) {
      runRecordingTask({
        activityId: activity.id,
        logger: input.logger,
        message: "gateway usage recording failed",
        requestId: input.requestId,
        task: () =>
          recorder.recordUsageCost({
            activityId: activity.id,
            agentId: input.agentId,
            usageCost,
            virtualModelId: input.virtualModelId,
          }),
      });
    }
  }

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
        startedAt,
        status: response.statusCode < 400 ? "succeeded" : "failed",
      }),
  });

  return response;
}

export async function executeRecordedGatewayStreamingRequest(input: {
  agentId: string;
  agentApiKeyPrefix: string;
  execute: (requestActivityId: string | undefined) => Promise<GatewayStreamingResult>;
  logger: FastifyBaseLogger;
  model: string;
  protocol: GatewayRequestActivityProtocol;
  recorder?: GatewayRequestRecorder;
  requestLoggingEnabled: boolean;
  requestId: string;
  virtualModelId: string;
}): Promise<GatewayStreamingResult> {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  const activity = await createActivity({
    input,
    recorder,
    stream: true,
  });
  const response = await input.execute(activity?.id);
  if (!response.ok) {
    if (activity) {
      scheduleCompleteActivity({
        activity,
        input,
        recorder,
        responseBody: response.body,
        responseMetadata: response.requestMetadata,
        route: response.activity,
        statusCode: response.statusCode,
      });
    }
    return response;
  }

  const usageCollector = createGatewayStreamingUsageCollector();
  return {
    ...response,
    body: wrapProviderStreamWithActivityCompletion(response.body, {
      collectChunk: (chunk) => usageCollector.collect(chunk),
      completeActivity: async ({ statusCode }) => {
        const providerUsage = usageCollector.readUsage();
        try {
          await settleGatewayStreamBudget({
            providerUsage,
            reservation: response.budgetReservation,
            statusCode,
            usageCost: response.usageCost,
          });
        } catch (error) {
          input.logger.error(
            { err: error, requestId: input.requestId },
            "gateway stream settlement failed",
          );
        }

        const usageCost = response.usageCost;
        if (activity && usageCost) {
          runRecordingTask({
            activityId: activity.id,
            logger: input.logger,
            message: "gateway stream usage recording failed",
            requestId: input.requestId,
            task: () =>
              recorder.recordUsageCost({
                activityId: activity.id,
                agentId: input.agentId,
                usageCost: {
                  ...usageCost,
                  ...(providerUsage ? { providerUsage } : {}),
                },
                virtualModelId: input.virtualModelId,
              }),
          });
        }

        if (activity) {
          scheduleCompleteActivity({
            activity,
            input,
            recorder,
            responseBody: providerUsage ? buildGatewayProviderUsageResponseBody(providerUsage) : {},
            responseMetadata: response.requestMetadata,
            route: response.activity,
            statusCode,
          });
        }
      },
      statusCode: response.statusCode,
    }),
  };
}

async function createActivity(input: {
  input: {
    agentId: string;
    agentApiKeyPrefix: string;
    logger: FastifyBaseLogger;
    model: string;
    protocol: GatewayRequestActivityProtocol;
    requestId: string;
    virtualModelId: string;
  };
  recorder: GatewayRequestRecorder;
  stream: boolean;
}): Promise<GatewayStartedRequestActivity | undefined> {
  try {
    return await input.recorder.createActivity({
      agentId: input.input.agentId,
      agentApiKeyPrefix: input.input.agentApiKeyPrefix,
      model: input.input.model,
      protocol: input.input.protocol,
      requestId: input.input.requestId,
      stream: input.stream,
      virtualModelId: input.input.virtualModelId,
    });
  } catch (error) {
    input.input.logger.error(
      { err: error, requestId: input.input.requestId },
      "gateway activity create failed",
    );
    return undefined;
  }
}

function scheduleCompleteActivity(input: {
  activity: GatewayStartedRequestActivity;
  input: {
    logger: FastifyBaseLogger;
    requestId: string;
    requestLoggingEnabled: boolean;
  };
  recorder: GatewayRequestRecorder;
  responseBody: unknown;
  responseMetadata?: GatewayRequestMetadata;
  route?: GatewayRequestActivityRoute;
  statusCode: number;
}): void {
  runRecordingTask({
    activityId: input.activity.id,
    logger: input.input.logger,
    message: "gateway activity complete failed",
    requestId: input.input.requestId,
    task: () =>
      input.recorder.completeActivity({
        activityId: input.activity.id,
        requestLoggingEnabled: input.input.requestLoggingEnabled,
        requestMetadata: input.responseMetadata,
        responseBody: input.responseBody,
        route: input.route,
        startedAt: input.activity.startedAt,
        statusCode: input.statusCode,
      }),
  });
}
