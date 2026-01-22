// middleware.ts (disable all auth and just pass requests through)
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

// Apply to all paths
export const config = {
  matcher: ["/:path*"],
};
