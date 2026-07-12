import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { readPostgresDatabaseUrl, withPooledPostgresClient } from "@llmingress/db/client";
import { consoleConflictError, consoleValidationError } from "./console-operation-error.ts";

export const sessionCookieName = "llmingress_console_session";

const passwordHashPrefix = "scrypt:v1";
const passwordKeyLength = 64;
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const scrypt = promisify(scryptCallback);

type AdminRow = {
  password_hash: string;
};

type SessionRow = {
  id: string;
};

export type ConsoleAuthState = "setup" | "login" | "authenticated";

export type ConsoleSession = {
  expiresAt: Date;
  token: string;
};

export async function hashAdminPassword(password: string): Promise<string> {
  assertUsablePassword(password);
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = (await scrypt(password, salt, passwordKeyLength)) as Buffer;
  return `${passwordHashPrefix}:${salt}:${derivedKey.toString("base64url")}`;
}

export async function verifyAdminPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  const parts = passwordHash.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== passwordHashPrefix) {
    return false;
  }

  const [, , salt, expectedHash] = parts;
  if (!salt || !expectedHash) {
    return false;
  }

  const expected = Buffer.from(expectedHash, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function readConsoleAuthState(sessionToken?: string): Promise<ConsoleAuthState>;
export async function readConsoleAuthState(
  databaseUrl: string | undefined,
  sessionToken?: string,
): Promise<ConsoleAuthState>;
export async function readConsoleAuthState(
  databaseUrlOrSessionToken?: string,
  maybeSessionToken?: string,
): Promise<ConsoleAuthState> {
  const { databaseUrl, sessionToken } = resolveDatabaseUrlAndSessionToken(
    databaseUrlOrSessionToken,
    maybeSessionToken,
  );
  if (!(await isConsoleInitialized(databaseUrl))) {
    return "setup";
  }

  if (await verifyConsoleSession(databaseUrl, sessionToken)) {
    return "authenticated";
  }

  return "login";
}

export async function isConsoleInitialized(databaseUrl?: string): Promise<boolean> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<{ exists: boolean }>(
      "select exists(select 1 from console_admins where id = 1) as exists",
    );
    return result.rows[0]?.exists ?? false;
  });
}

export async function createAdminPassword(password: string): Promise<void>;
export async function createAdminPassword(
  databaseUrl: string | undefined,
  password: string,
): Promise<void>;
export async function createAdminPassword(
  databaseUrlOrPassword: string | undefined,
  maybePassword?: string,
): Promise<void> {
  const databaseUrl = maybePassword ? databaseUrlOrPassword : undefined;
  const password = maybePassword ?? databaseUrlOrPassword;
  if (!password) {
    throw consoleValidationError("Admin password is required.", "form_field_required", {
      field: "password",
    });
  }
  const passwordHash = await hashAdminPassword(password);

  try {
    await withPooledPostgresClient(databaseUrl ?? readPostgresDatabaseUrl(), async (client) => {
      await client.query("insert into console_admins (id, password_hash) values (1, $1)", [
        passwordHash,
      ]);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw consoleConflictError("Console is already initialized.", "console_already_initialized");
    }
    throw error;
  }
}

export async function loginConsoleAdmin(password: string): Promise<ConsoleSession | null>;
export async function loginConsoleAdmin(
  databaseUrl: string | undefined,
  password: string,
): Promise<ConsoleSession | null>;
export async function loginConsoleAdmin(
  databaseUrlOrPassword: string | undefined,
  maybePassword?: string,
): Promise<ConsoleSession | null> {
  const databaseUrl = maybePassword ? databaseUrlOrPassword : undefined;
  const password = maybePassword ?? databaseUrlOrPassword;
  if (!password) {
    throw consoleValidationError("Admin password is required.", "form_field_required", {
      field: "password",
    });
  }
  const admin = await withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<AdminRow>(
      "select password_hash from console_admins where id = 1",
    );
    return result.rows[0];
  });

  if (!admin || !(await verifyAdminPassword(password, admin.password_hash))) {
    return null;
  }

  return createConsoleSession(databaseUrl);
}

export async function verifyConsoleSession(sessionToken?: string): Promise<boolean>;
export async function verifyConsoleSession(
  databaseUrl: string | undefined,
  sessionToken?: string,
): Promise<boolean>;
export async function verifyConsoleSession(
  databaseUrlOrSessionToken?: string,
  maybeSessionToken?: string,
): Promise<boolean> {
  const { databaseUrl, sessionToken } = resolveDatabaseUrlAndSessionToken(
    databaseUrlOrSessionToken,
    maybeSessionToken,
  );
  if (!sessionToken) {
    return false;
  }

  const tokenHash = hashSessionToken(sessionToken);
  return withPooledPostgresClient(databaseUrl, async (client) => {
    const result = await client.query<SessionRow>(
      `
        select id
        from console_sessions
        where token_hash = $1
          and expires_at > now()
        limit 1
      `,
      [tokenHash],
    );
    return result.rowCount === 1;
  });
}

export async function deleteConsoleSession(sessionToken?: string): Promise<void>;
export async function deleteConsoleSession(
  databaseUrl: string | undefined,
  sessionToken?: string,
): Promise<void>;
export async function deleteConsoleSession(
  databaseUrlOrSessionToken?: string,
  maybeSessionToken?: string,
): Promise<void> {
  const { databaseUrl, sessionToken } = resolveDatabaseUrlAndSessionToken(
    databaseUrlOrSessionToken,
    maybeSessionToken,
  );
  if (!sessionToken) {
    return;
  }

  await withPooledPostgresClient(databaseUrl, async (client) => {
    await client.query("delete from console_sessions where token_hash = $1", [
      hashSessionToken(sessionToken),
    ]);
  });
}

export function getSessionCookieOptions(expiresAt: Date) {
  return {
    expires: expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

function assertUsablePassword(password: string): void {
  if (password.length < 8) {
    throw consoleValidationError(
      "Admin password must be at least 8 characters.",
      "admin_password_too_short",
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function createConsoleSession(databaseUrl: string | undefined): Promise<ConsoleSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDurationMs);

  await withPooledPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `
        insert into console_sessions (id, token_hash, expires_at)
        values ($1, $2, $3)
      `,
      [randomUUID(), hashSessionToken(token), expiresAt],
    );
  });

  return { expiresAt, token };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function resolveDatabaseUrlAndSessionToken(
  databaseUrlOrSessionToken?: string,
  maybeSessionToken?: string,
): { databaseUrl?: string; sessionToken?: string } {
  if (maybeSessionToken !== undefined) {
    return {
      databaseUrl: databaseUrlOrSessionToken ?? readPostgresDatabaseUrl(),
      sessionToken: maybeSessionToken,
    };
  }

  return {
    databaseUrl: readPostgresDatabaseUrl(),
    sessionToken: databaseUrlOrSessionToken,
  };
}
