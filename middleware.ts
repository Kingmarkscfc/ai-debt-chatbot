
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const USER = process.env.BASIC_AUTH_USER || 'mark';
const PASS = process.env.BASIC_AUTH_PASS || 'secure123';

export function middleware(request: NextRequest) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const encoded = authHeader.split(' ')[1];
    const decoded = atob(encoded);
    const [user, pass] = decoded.split(':');

    if (user === USER && pass === PASS) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Secure Area"',
    },
  });
}

export const config = {
  matcher: ['/:path*'],
};
