import { randomUUID } from "node:crypto";
import {
  getPostgresPool,
  type PostgresQueryClient,
  type PostgresQueryResultRow,
  withPostgresTransaction,
} from "@llmingress/db/client";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";

export type GatewayRateLimitType = "concurrency" | "rpm" | "tpm";
export type GatewayRateLimitEnforcementPolicy = "block" | "warn_only";

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
  | {
      concurrencyLease?: GatewayConcurrencyLease;
      ok: true;
    }
  | {
      body: GatewayRateLimitErrorBody;
      ok: false;
      retryAfterSeconds: number;
      statusCode: 429;
    };

export type GatewayConcurrencyLease = {
  agentApiKeyId: string;
  window: WindowBoundary;
};

type AgentLimitRow = PostgresQueryResultRow & {
  enforcement_policy: GatewayRateLimitEnforcementPolicy;
  limit_type: GatewayRateLimitType;
  limit_value: string;
  manual_bypass: boolean;
};

type RateLimitWindowRow = PostgresQueryResultRow & {
  active_count: number;
  request_count: number;
  token_count: number;
};

type WindowBoundary = {
  windowEnd: Date;
  windowStart: Date;
};

export async function enforceGatewayRateLimits(input: {
  agentApiKeyId: string;
  databaseUrl?: string;
  requestId: string;
  requestMetadata: GatewayRequestMetadata;
}): Promise<GatewayRateLimitDecision> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const limits = await readEnabledGatewayRateLimits(client, input.agentApiKeyId);
    if (limits.length === 0) {
      return { ok: true };
    }

    const now = new Date();
    const window = getMinuteWindow(now);
    const increments = limits.map((limit) => ({
      enforcementPolicy: limit.enforcementPolicy,
      increment:
        limit.limitType === "rpm"
          ? 1
          : limit.limitType === "tpm"
            ? input.requestMetadata.estimatedInputTokens +
              input.requestMetadata.estimatedOutputTokens
            : 1,
      limitType: limit.limitType,
      limitValue: limit.limitValue,
      manualBypass: limit.manualBypass,
      window: limit.limitType === "concurrency" ? getConcurrencyWindow() : window,
    }));

    for (const increment of increments) {
      const currentCount = await lockRateLimitWindow(client, {
        agentApiKeyId: input.agentApiKeyId,
        limitType: increment.limitType,
        window: increment.window,
      });
      const decision = evaluateGatewayRateLimitWindow({
        currentCount:
          increment.limitType === "rpm"
            ? currentCount.requestCount
            : increment.limitType === "tpm"
              ? currentCount.tokenCount
              : currentCount.activeCount,
        enforcementPolicy: increment.enforcementPolicy,
        increment: increment.increment,
        limitType: increment.limitType,
        limitValue: increment.limitValue,
        manualBypass: increment.manualBypass,
        requestId: input.requestId,
        retryAfterMs:
          increment.limitType === "concurrency"
            ? 1
            : Math.max(1, window.windowEnd.getTime() - now.getTime()),
      });
      if (!decision.ok) {
        return decision;
      }
    }

    for (const increment of increments) {
      await incrementRateLimitWindow(client, {
        agentApiKeyId: input.agentApiKeyId,
        increment: increment.increment,
        limitType: increment.limitType,
        window: increment.window,
      });
    }

    const concurrencyIncrement = increments.find(
      (increment) => increment.limitType === "concurrency",
    );
    return {
      concurrencyLease: concurrencyIncrement
        ? { agentApiKeyId: input.agentApiKeyId, window: concurrencyIncrement.window }
        : undefined,
      ok: true,
    };
  });
}

export async function releaseGatewayConcurrency(input: {
  databaseUrl?: string;
  lease: GatewayConcurrencyLease | undefined;
}): Promise<void> {
  if (!input.lease) {
    return;
  }

  await getPostgresPool(input.databaseUrl).query(
    `
      update rate_limit_windows
      set active_count = greatest(active_count - 1, 0),
          updated_at = now()
      where agent_id = $1
        and limit_type = 'concurrency'
        and window_start = $2
    `,
    [input.lease.agentApiKeyId, input.lease.window.windowStart],
  );
}

export function getMinuteWindow(date: Date): WindowBoundary {
  const windowStart = new Date(date);
  windowStart.setUTCSeconds(0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCMinutes(windowEnd.getUTCMinutes() + 1);
  return { windowEnd, windowStart };
}

export function getConcurrencyWindow(): WindowBoundary {
  return {
    windowEnd: new Date("9999-12-31T23:59:59.999Z"),
    windowStart: new Date("1970-01-01T00:00:00.000Z"),
  };
}

export function evaluateGatewayRateLimitWindow(input: {
  currentCount: number;
  enforcementPolicy?: GatewayRateLimitEnforcementPolicy;
  increment: number;
  limitType: GatewayRateLimitType;
  limitValue: number;
  manualBypass?: boolean;
  requestId: string;
  retryAfterMs: number;
}): GatewayRateLimitDecision {
  if (input.currentCount + input.increment <= input.limitValue) {
    return { ok: true };
  }
  if (input.manualBypass || input.enforcementPolicy === "warn_only") {
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

async function readEnabledGatewayRateLimits(
  client: PostgresQueryClient,
  agentApiKeyId: string,
): Promise<
  Array<{
    enforcementPolicy: GatewayRateLimitEnforcementPolicy;
    limitType: GatewayRateLimitType;
    limitValue: number;
    manualBypass: boolean;
  }>
> {
  const result = await client.query<AgentLimitRow>(
    `
      select limit_type,
             limit_value::text,
             enforcement_policy,
             manual_bypass
      from agent_limits
      where agent_id = $1
        and enabled = true
        and (
          (limit_type = 'concurrency' and period = 'request' and unit = 'requests')
          or (limit_type = 'rpm' and period = 'minute' and unit = 'requests')
          or (limit_type = 'tpm' and period = 'minute' and unit = 'tokens')
        )
      order by case limit_type when 'concurrency' then 1 when 'rpm' then 2 else 3 end
    `,
    [agentApiKeyId],
  );

  return result.rows.map((row) => ({
    enforcementPolicy: row.enforcement_policy,
    limitType: row.limit_type,
    limitValue: Number(row.limit_value),
    manualBypass: row.manual_bypass,
  }));
}

async function lockRateLimitWindow(
  client: PostgresQueryClient,
  input: {
    agentApiKeyId: string;
    limitType: GatewayRateLimitType;
    window: WindowBoundary;
  },
): Promise<{ activeCount: number; requestCount: number; tokenCount: number }> {
  await client.query(
    `
      insert into rate_limit_windows (
        id,
        agent_id,
        limit_type,
        window_start,
        window_end
      )
      values ($1, $2, $3, $4, $5)
      on conflict (agent_id, limit_type, window_start) do nothing
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
             token_count,
             active_count
      from rate_limit_windows
      where agent_id = $1
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
    activeCount: Number(row.active_count),
    requestCount: Number(row.request_count),
    tokenCount: Number(row.token_count),
  };
}

async function incrementRateLimitWindow(
  client: PostgresQueryClient,
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
          active_count = active_count + $3,
          updated_at = now()
      where agent_id = $4
        and limit_type = $5
        and window_start = $6
    `,
    [
      input.limitType === "rpm" ? 1 : 0,
      input.limitType === "tpm" ? input.increment : 0,
      input.limitType === "concurrency" ? input.increment : 0,
      input.agentApiKeyId,
      input.limitType,
      input.window.windowStart,
    ],
  );
}
