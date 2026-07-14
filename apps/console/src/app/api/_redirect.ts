import { NextResponse } from "next/server";

export function redirectToConsolePath(path: string | URL, status = 303): NextResponse {
  const location = typeof path === "string" ? path : `${path.pathname}${path.search}${path.hash}`;
  return new NextResponse(null, {
    headers: { Location: location },
    status,
  });
}
