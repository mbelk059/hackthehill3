import Link from "next/link";
import { authConfigured, getSessionUser } from "../lib/auth.js";

export default async function HomePage() {
  const user = await getSessionUser();
  const auth0 = authConfigured();
  const dev = process.env.DEV_AUTH_BYPASS === "1";

  return (
    <main className="page home">
      <header className="home-bar">
        <p className="home-mark">Bunny Buddy</p>
        <div className="actions">
          {user?.email ? <span className="who">{user.email}</span> : null}
          {auth0 && !user ? <a className="button" href="/auth/login">Log in</a> : null}
          {auth0 && user ? <a className="button quiet" href="/auth/logout">Log out</a> : null}
          <Link className="button" href="/dashboard">Dashboard</Link>
        </div>
      </header>
      <section className="home-hero">
        <div>
          <h1>Stay accountable.<br />Stay focused.</h1>
          <p className="lede">
            Share a tab and hold the mascot when you want a hint. Dashboard tracks the times you stayed and the times you drifted.
          </p>
          {!auth0 && dev ? <p className="who">Local dev mode until Auth0 is filled in.</p> : null}
        </div>
        <img className="home-mascot" src="/mascot.png" alt="" />
      </section>
    </main>
  );
}
