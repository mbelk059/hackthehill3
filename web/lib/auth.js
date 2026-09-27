let auth0Promise;

export function authConfigured() {
  return Boolean(
    process.env.AUTH0_DOMAIN &&
      process.env.AUTH0_CLIENT_ID &&
      process.env.AUTH0_CLIENT_SECRET &&
      process.env.AUTH0_SECRET,
  );
}

export async function getAuth0() {
  if (!authConfigured()) return null;
  if (!auth0Promise) {
    auth0Promise = import("@auth0/nextjs-auth0/server").then(({ Auth0Client }) => {
      return new Auth0Client({
        domain: process.env.AUTH0_DOMAIN,
        clientId: process.env.AUTH0_CLIENT_ID,
        clientSecret: process.env.AUTH0_CLIENT_SECRET,
        secret: process.env.AUTH0_SECRET,
        appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
        signInReturnToPath: "/dashboard",
        authorizationParameters: {
          audience: process.env.AUTH0_AUDIENCE || undefined,
          scope: "openid profile email",
        },
      });
    });
  }
  return auth0Promise;
}

export async function getSessionUser() {
  const auth0 = await getAuth0();
  if (!auth0) return null;
  const session = await auth0.getSession();
  if (!session?.user?.sub) return null;
  return { sub: session.user.sub, email: session.user.email || "" };
}
