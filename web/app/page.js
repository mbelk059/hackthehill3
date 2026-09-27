import { redirect } from "next/navigation";
import { authConfigured, getSessionUser } from "../lib/auth.js";

export default async function HomePage() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  const auth0 = authConfigured();
  const dev = process.env.DEV_AUTH_BYPASS === "1";
  const enter = auth0 ? "/auth/login" : "/dashboard";

  return (
    <main className="page home">
      <header className="home-bar">
        <p className="home-mark">Bunny Buddy</p>
        <div className="actions">
          <a className="button" href={enter}>{auth0 ? "Log in" : "Open dashboard"}</a>
        </div>
      </header>

      <section className="home-hero">
        <div>
          <p className="eyebrow">Your new favourite study buddy</p>
          <h1>A bunny that<br />studies with you.</h1>
          <p className="lede">
            Share your tab, ask a question, and get a hint. Look away and it will notice.
          </p>
          <div className="home-cta">
            <a className="button" href={enter}>{auth0 ? "Log in" : "Open dashboard"}</a>
          </div>
          {!auth0 && dev ? <p className="who">Local dev mode until Auth0 is filled in.</p> : null}
        </div>
        <img className="home-mascot" src="/mascot.png" alt="Bunny Buddy" />
      </section>

      <section className="home-block">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <span>01</span>
            <p>Open your study tab and start the bunny next to it.</p>
          </li>
          <li>
            <span>02</span>
            <p>Ask out loud. It looks at the page and gives you a hint.</p>
          </li>
          <li>
            <span>03</span>
            <p>The dashboard shows when you stayed with it, and when you drifted.</p>
          </li>
        </ol>
      </section>

      <section className="home-block">
        <h2>Three moods</h2>
        <div className="mode-grid">
          <article className="card">
            <p className="label">Bunny Buddy</p>
            <p>The normal one. Short answers, no lecture.</p>
          </article>
          <article className="card mode-strict">
            <p className="label">Strict Bunny</p>
            <p>When you look away, or when you say lock in.</p>
          </article>
          <article className="card mode-nice">
            <p className="label">Nice Bunny</p>
            <p>When you seem stressed, or when you ask it to be nicer.</p>
          </article>
        </div>
      </section>

      <footer className="site-footer">
        <p>Made with ♥ by M, S, and I</p>
      </footer>
    </main>
  );
}
