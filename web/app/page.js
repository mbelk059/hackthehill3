import Link from "next/link";
import { authConfigured, getSessionUser } from "../lib/auth.js";

export default async function HomePage() {
  const user = await getSessionUser();
  const auth0 = authConfigured();
  const dev = process.env.DEV_AUTH_BYPASS === "1";

  return (
    <main className="page">
      <div className="top">
        <div className="brand">
          <img src="/mascot.png" alt="" />
          <div>
            <h1>Study Mascot</h1>
            <p className="lede">
              Share a tab, ask the mascot for a hint, and come back here to see when you stayed with it.
            </p>
          </div>
        </div>
        <div className="actions">
          {auth0 && !user ? <a className="button" href="/auth/login">Log in</a> : null}
          {auth0 && user ? <a className="button quiet" href="/auth/logout">Log out</a> : null}
          <Link className="button" href="/dashboard">Dashboard</Link>
        </div>
      </div>
      <section className="panel">
        <h2>How a session works</h2>
        <p>Install the extension, start studying on a tab, and hold the mascot to ask a question.</p>
        <p>Screen frames and the webcam stay on this computer. The dashboard only stores focus changes and question counts.</p>
        {!auth0 && dev ? <p>Auth0 is not filled in yet, so the dashboard opens in local dev mode.</p> : null}
        {user?.email ? <p>Signed in as {user.email}.</p> : null}
      </section>
    </main>
  );
}
