// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROD =
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

// Paths that must ALWAYS be protected (admin tools, dashboards, etc.)
const ALWAYS_PROTECT = [/^\/admin(\/|$)/, /^\/internal(\/|$)/, /^\/tools(\/|$)/];

// Optional: allow-list public paths explicitly (leave empty to allow all)
const PUBLIC_PATHS = [
  /^\/$/,                         // home
  /^\/api\/chat$/,                // chat API
  /^\/api\/portal\/(login|register|request-reset|profile)$/, // portal APIs
  /^\/_next\/.*/,                 // Next assets
  /^\/assets\/.*/,                // static assets
];

function needsAuth(pathname: string): boolean {
  // Protect admin/internal paths always
  if (ALWAYS_PROTECT.some((re) => re.test(pathname))) return true;

  // In preview/dev: protect everything EXCEPT allowed public paths
  if (!PROD) {
    const isPublic = PUBLIC_PATHS.some((re) => re.test(pathname));
    return !isPublic;
  }

  // In prod: only protect ALWAYS_PROTECT
  return false;
}

export function middleware(req: NextRequest) {
  const { pathname } = new URL(req.url);

  if (!needsAuth(pathname)) return NextResponse.next();

  const user = process.env.BASIC_USER || "preview";
  const pass = process.env.BASIC_PASS || "preview";

  const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const auth = req.headers.get("authorization");

  if (auth === expected) return NextResponse.next();

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Secure Area"' },
  });
}

export const config = {
  matcher: ["/:path*"],
};
