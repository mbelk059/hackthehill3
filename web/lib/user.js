import { createRemoteJWKSet, jwtVerify } from "jose";
import { getSessionUser } from "./auth.js";

let jwks;

export async function verifyBearer(header) {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (process.env.DEV_AUTH_BYPASS === "1" && token === "dev") {
    return { sub: "dev|local", email: "dev@localhost" };
  }
  if (!process.env.AUTH0_DOMAIN) return null;
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`));
  }
  const options = { issuer: `https://${process.env.AUTH0_DOMAIN}/` };
  if (process.env.AUTH0_AUDIENCE) options.audience = process.env.AUTH0_AUDIENCE;
  const { payload } = await jwtVerify(token, jwks, options);
  return { sub: payload.sub, email: payload.email || "" };
}

export async function getRequestUser(request) {
  try {
    const bearer = await verifyBearer(request.headers.get("authorization"));
    if (bearer) return bearer;
  } catch {
    return null;
  }
  const sessionUser = await getSessionUser();
  if (sessionUser) return sessionUser;
  if (process.env.DEV_AUTH_BYPASS === "1") return { sub: "dev|local", email: "dev@localhost" };
  return null;
}
