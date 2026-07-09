import { exportConsoleConfig } from "@llmingress/db/console-import-export";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";

export const GET = withConsoleAuth(async () => {
  const exported = await exportConsoleConfig();
  return new NextResponse(`${JSON.stringify(exported, null, 2)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="llmingress-config-export.json"',
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
});
