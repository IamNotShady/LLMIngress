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
  type GatewayStreamingResult,
  wrapProviderStreamWithActivityCompletion,
} from "@llmingress/db/gateway-streaming";
import { recordGatewayRequestTrace } from "@llmingress/db/gateway-tracing";
import {
  buildGatewayProviderUsageResponseBody,
  createGatewayStreamingUsageCollector,
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

export async function executeRecordedGatewayJsonRequest(input: {
  agentApiKeyId: string;
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
    try {
      await recorder.completeActivity({
        activityId: activity.id,
        requestLoggingEnabled: input.requestLoggingEnabled,
        requestMetadata: response.requestMetadata,
        responseBody: response.body,
        route: response.activity,
        startedAt,
        statusCode: response.statusCode,
      });
    } catch (error) {
      input.logger.error(
        { activityId: activity.id, err: error, requestId: input.requestId },
        "gateway activity complete failed",
      );
    }

    if (response.statusCode < 400 && response.usageCost) {
      try {
        await recorder.recordUsageCost({
          activityId: activity.id,
          agentApiKeyId: input.agentApiKeyId,
          usageCost: response.usageCost,
          virtualModelId: input.virtualModelId,
        });
      } catch (error) {
        input.logger.error(
          { activityId: activity.id, err: error, requestId: input.requestId },
          "gateway usage recording failed",
        );
      }
    }
  }

  try {
    await recorder.recordTrace({
      errorCode: readGatewayActivityError(response.body)?.errorCode ?? null,
      httpStatus: response.statusCode,
      modelId: response.activity?.modelId ?? null,
      protocol: input.protocol,
      providerKey: response.activity?.providerKey ?? null,
      requestId: input.requestId,
      startedAt,
      status: response.statusCode < 400 ? "succeeded" : "failed",
    });
  } catch (error) {
    input.logger.error(
      { err: error, requestId: input.requestId },
      "gateway trace recording failed",
    );
  }

  return response;
}

export async function executeRecordedGatewayStreamingRequest(input: {
  agentApiKeyId: string;
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
      await completeActivitySafely({
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
        if (activity && response.usageCost) {
          try {
            await recorder.recordUsageCost({
              activityId: activity.id,
              agentApiKeyId: input.agentApiKeyId,
              usageCost: {
                ...response.usageCost,
                ...(providerUsage ? { providerUsage } : {}),
              },
              virtualModelId: input.virtualModelId,
            });
          } catch (error) {
            input.logger.error(
              { activityId: activity.id, err: error, requestId: input.requestId },
              "gateway stream usage recording failed",
            );
          }
        }

        if (activity) {
          await completeActivitySafely({
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
    agentApiKeyId: string;
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
      agentApiKeyId: input.input.agentApiKeyId,
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

async function completeActivitySafely(input: {
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
}): Promise<void> {
  try {
    await input.recorder.completeActivity({
      activityId: input.activity.id,
      requestLoggingEnabled: input.input.requestLoggingEnabled,
      requestMetadata: input.responseMetadata,
      responseBody: input.responseBody,
      route: input.route,
      startedAt: input.activity.startedAt,
      statusCode: input.statusCode,
    });
  } catch (error) {
    input.input.logger.error(
      { activityId: input.activity.id, err: error, requestId: input.input.requestId },
      "gateway activity complete failed",
    );
  }
}
