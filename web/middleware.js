import { NextResponse } from "next/server";

export async function middleware(request) {
  if (!process.env.AUTH0_DOMAIN || !process.env.AUTH0_SECRET || !process.env.AUTH0_CLIENT_ID) {
    return NextResponse.next();
  }
  const { getAuth0 } = await import("./lib/auth.js");
  const auth0 = await getAuth0();
  if (!auth0) return NextResponse.next();
  return auth0.middleware(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|mascot.png).*)"],
};
