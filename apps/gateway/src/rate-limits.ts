import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import type { GatewayRequestMetadata } from "./request-metadata.js";

export type GatewayRateLimitType = "rpm" | "tpm";

export type GatewayRateLimitErrorBody = {
  error: {
    code: "rate_limit_exceeded";
    message: string;
  };
  limitType: GatewayRateLimitType;
  requestId: string;
  retryAfterMs: number;
  retryAfterSeconds: number;
};

export type GatewayRateLimitDecision =
  | { ok: true }
  | {
      body: GatewayRateLimitErrorBody;
      ok: false;
      retryAfterSeconds: number;
      statusCode: 429;
    };

type AgentLimitRow = QueryResultRow & {
  limit_type: GatewayRateLimitType;
  limit_value: string;
};

type RateLimitWindowRow = QueryResultRow & {
  request_count: number;
  token_count: number;
};

type WindowBoundary = {
  windowEnd: Date;
  windowStart: Date;
};

export async function enforceGatewayRateLimits(input: {
  agentApiKeyId: string;
  databaseUrl: string;
  requestId: string;
  requestMetadata: GatewayRequestMetadata;
}): Promise<GatewayRateLimitDecision> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    await client.query("begin");
    const limits = await readEnabledMinuteLimits(client, input.agentApiKeyId);
    if (limits.length === 0) {
      await client.query("commit");
      return { ok: true };
    }

    const now = new Date();
    const window = getMinuteWindow(now);
    const increments = limits.map((limit) => ({
      increment:
        limit.limitType === "rpm"
          ? 1
          : input.requestMetadata.estimatedInputTokens +
            input.requestMetadata.estimatedOutputTokens,
      limitType: limit.limitType,
      limitValue: limit.limitValue,
    }));

    for (const increment of increments) {
      const currentCount = await lockRateLimitWindow(client, {
        agentApiKeyId: input.agentApiKeyId,
        limitType: increment.limitType,
        window,
      });
      const decision = evaluateGatewayRateLimitWindow({
        currentCount:
          increment.limitType === "rpm" ? currentCount.requestCount : currentCount.tokenCount,
        increment: increment.increment,
        limitType: increment.limitType,
        limitValue: increment.limitValue,
        requestId: input.requestId,
        retryAfterMs: Math.max(1, window.windowEnd.getTime() - now.getTime()),
      });
      if (!decision.ok) {
        await client.query("rollback");
        return decision;
      }
    }

    for (const increment of increments) {
      await incrementRateLimitWindow(client, {
        agentApiKeyId: input.agentApiKeyId,
        increment: increment.increment,
        limitType: increment.limitType,
        window,
      });
    }

    await client.query("commit");
    return { ok: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function getMinuteWindow(date: Date): WindowBoundary {
  const windowStart = new Date(date);
  windowStart.setUTCSeconds(0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCMinutes(windowEnd.getUTCMinutes() + 1);
  return { windowEnd, windowStart };
}

export function evaluateGatewayRateLimitWindow(input: {
  currentCount: number;
  increment: number;
  limitType: GatewayRateLimitType;
  limitValue: number;
  requestId: string;
  retryAfterMs: number;
}): GatewayRateLimitDecision {
  if (input.currentCount + input.increment <= input.limitValue) {
    return { ok: true };
  }

  const body = createGatewayRateLimitErrorBody({
    limitType: input.limitType,
    requestId: input.requestId,
    retryAfterMs: input.retryAfterMs,
  });

  return {
    body,
    ok: false,
    retryAfterSeconds: body.retryAfterSeconds,
    statusCode: 429,
  };
}

export function createGatewayRateLimitErrorBody(input: {
  limitType: GatewayRateLimitType;
  requestId: string;
  retryAfterMs: number;
}): GatewayRateLimitErrorBody {
  const retryAfterSeconds = Math.max(1, Math.ceil(input.retryAfterMs / 1000));
  return {
    error: {
      code: "rate_limit_exceeded",
      message: `Agent API key exceeded its ${input.limitType.toUpperCase()} limit.`,
    },
    limitType: input.limitType,
    requestId: input.requestId,
    retryAfterMs: input.retryAfterMs,
    retryAfterSeconds,
  };
}

async function readEnabledMinuteLimits(
  client: Client,
  agentApiKeyId: string,
): Promise<Array<{ limitType: GatewayRateLimitType; limitValue: number }>> {
  const result = await client.query<AgentLimitRow>(
    `
      select limit_type,
             limit_value::text
      from agent_limits
      where agent_api_key_id = $1
        and enabled = true
        and period = 'minute'
        and ((limit_type = 'rpm' and unit = 'requests')
          or (limit_type = 'tpm' and unit = 'tokens'))
      order by case limit_type when 'rpm' then 1 else 2 end
    `,
    [agentApiKeyId],
  );

  return result.rows.map((row) => ({
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
  }));
}

async function lockRateLimitWindow(
  client: Client,
  input: {
    agentApiKeyId: string;
    limitType: GatewayRateLimitType;
    window: WindowBoundary;
  },
): Promise<{ requestCount: number; tokenCount: number }> {
  await client.query(
    `
      insert into rate_limit_windows (
        id,
        agent_api_key_id,
        limit_type,
        window_start,
        window_end
      )
      values ($1, $2, $3, $4, $5)
      on conflict (agent_api_key_id, limit_type, window_start) do nothing
    `,
    [
      randomUUID(),
      input.agentApiKeyId,
      input.limitType,
      input.window.windowStart,
      input.window.windowEnd,
    ],
  );

  const result = await client.query<RateLimitWindowRow>(
    `
      select request_count,
             token_count
      from rate_limit_windows
      where agent_api_key_id = $1
        and limit_type = $2
        and window_start = $3
      for update
    `,
    [input.agentApiKeyId, input.limitType, input.window.windowStart],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Rate limit window was not created.");
  }

  return {
    requestCount: Number(row.request_count),
    tokenCount: Number(row.token_count),
  };
}

async function incrementRateLimitWindow(
  client: Client,
  input: {
    agentApiKeyId: string;
    increment: number;
    limitType: GatewayRateLimitType;
    window: WindowBoundary;
  },
): Promise<void> {
  await client.query(
    `
      update rate_limit_windows
      set request_count = request_count + $1,
          token_count = token_count + $2,
          updated_at = now()
      where agent_api_key_id = $3
        and limit_type = $4
        and window_start = $5
    `,
    [
      input.limitType === "rpm" ? 1 : 0,
      input.limitType === "tpm" ? input.increment : 0,
      input.agentApiKeyId,
      input.limitType,
      input.window.windowStart,
    ],
  );
}
