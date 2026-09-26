"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatRange(start, end) {
  const started = new Date(start).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (!end) return `${started} · still open`;
  const minutes = Math.max(1, Math.round((new Date(end) - new Date(start)) / 60000));
  return `${started} · ${minutes} min`;
}

export default function DashboardClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load the dashboard.");
        if (!cancelled) setData(body);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="panel">{error}</p>;
  if (!data) return <p className="panel">Loading focus history…</p>;

  return (
    <>
      <div className="stats">
        <article className="card">
          <p className="label">Focus today</p>
          <p className="stat">{data.focusPct}%</p>
        </article>
        <article className="card">
          <p className="label">Distractions</p>
          <p className="stat">{data.distractionCount}</p>
        </article>
        <article className="card">
          <p className="label">Questions</p>
          <p className="stat">{data.questionCount}</p>
        </article>
      </div>
      <section className="panel">
        <h2>Focus over time</h2>
        {data.focusSeries.length ? (
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.focusSeries}>
                <CartesianGrid stroke="#e4d3b8" />
                <XAxis dataKey="time" tickFormatter={formatTime} stroke="#241c16" />
                <YAxis domain={[0, 100]} stroke="#241c16" unit="%" />
                <Tooltip labelFormatter={formatTime} />
                <Line type="stepAfter" dataKey="focus" stroke="#2f6b4f" strokeWidth={3} dot={false} name="Focus" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="empty">Start a study session and your focus will show up here.</p>
        )}
      </section>
      <section className="panel">
        <h2>Sessions</h2>
        {data.sessions.length ? (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Focus</th>
                <th>Distractions</th>
                <th>Questions</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((session) => (
                <tr key={session.id}>
                  <td>{formatRange(session.startedAt, session.endedAt)}</td>
                  <td>{session.focusPct}%</td>
                  <td>{session.distractions}</td>
                  <td>{session.questions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No sessions yet.</p>
        )}
      </section>
      <p className="label">
        Stored in {data.storage === "tiger" ? "Tiger Data" : "a local file until DATABASE_URL is set"}.
      </p>
    </>
  );
}
