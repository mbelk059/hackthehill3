import Link from "next/link";
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
        <Link className="button quiet" href="/">Home</Link>
      </div>
      <DashboardClient />
    </main>
  );
}
