import DashboardClient from "./DashboardClient.js";

export default function DashboardPage() {
  return (
    <main className="page">
      <div className="top">
        <div className="brand">
          <img src="/mascot.png" alt="" />
          <div>
            <h1>Focus</h1>
            <p className="lede">Minutes you stayed with the work, and the times you drifted.</p>
          </div>
        </div>
        <a className="button quiet" href="/auth/logout">Log out</a>
      </div>
      <DashboardClient />
    </main>
  );
}
