"use client";

import { useEffect, useState, useRef } from "react";
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
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRange(start, end) {
  const started = new Date(start).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (!end) return `${started} · still open`;
  const minutes = Math.max(
    1,
    Math.round((new Date(end) - new Date(start)) / 60000),
  );
  return `${started} · ${minutes} min`;
}

export default function DashboardClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // --- ADDing AFK STATE & LOGIC HERE ---
  const [afkEnabled, setAfkEnabled] = useState(true);
  const [afkMinutes, setAfkMinutes] = useState(10);
  const [isAfk, setIsAfk] = useState(false);
  const timerRef = useRef(null);

  const handleUpdateSettings = (enabled, minutes) => {
    setAfkEnabled(enabled);
    setAfkMinutes(minutes);
    const config = { afkEnabled: enabled, afkMinutes: minutes };
    if (typeof window !== "undefined") {
      localStorage.setItem("afk_config", JSON.stringify(config));
      window.postMessage({ type: "UPDATE_AFK_SETTINGS", config }, "*");
    }
  };

  const resetTimer = () => {
    if (isAfk) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!afkEnabled) return;

    timerRef.current = setTimeout(
      () => {
        setIsAfk(true);
      },
      afkMinutes * 60 * 1000,
    );
  };

  useEffect(() => {
    const savedConfig = localStorage.getItem("afk_config");
    if (savedConfig) {
      try {
        const { afkEnabled: savedEnabled, afkMinutes: savedMins } =
          JSON.parse(savedConfig);
        if (typeof savedEnabled === "boolean") setAfkEnabled(savedEnabled);
        if (typeof savedMins === "number") setAfkMinutes(savedMins);
      } catch (e) {}
    }
  }, []);

  useEffect(() => {
    const events = ["mousemove", "keydown", "click", "scroll"];
    const handleActivity = () => resetTimer();

    events.forEach((evt) => window.addEventListener(evt, handleActivity));
    resetTimer();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach((evt) => window.removeEventListener(evt, handleActivity));
    };
  }, [afkEnabled, afkMinutes, isAfk]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard")
      .then(async (response) => {
        const text = await response.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new Error("Could not load the dashboard.");
        }
        if (!response.ok)
          throw new Error(body.error || "Could not load the dashboard.");
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
      {/* --- ADD AFK SETTINGS PANEL HERE --- */}
      <section className="panel" style={{ marginBottom: "1rem" }}>
        <h2>AFK Inactivity Nudge</h2>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
          }}
        >
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <input
              type="checkbox"
              checked={afkEnabled}
              onChange={(e) =>
                handleUpdateSettings(e.target.checked, afkMinutes)
              }
            />
            Enable AFK Reminders
          </label>

          {afkEnabled && (
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              Threshold (min):
              <input
                type="number"
                min="1"
                max="120"
                value={afkMinutes}
                onChange={(e) =>
                  handleUpdateSettings(afkEnabled, Number(e.target.value))
                }
                style={{ width: "60px", padding: "4px" }}
              />
            </label>
          )}
        </div>
      </section>

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
                <XAxis
                  dataKey="time"
                  tickFormatter={formatTime}
                  stroke="#241c16"
                />
                <YAxis domain={[0, 100]} stroke="#241c16" unit="%" />
                <Tooltip labelFormatter={formatTime} />
                <Line
                  type="stepAfter"
                  dataKey="focus"
                  stroke="#2f6b4f"
                  strokeWidth={3}
                  dot={false}
                  name="Focus"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="empty">
            Start a study session and your focus will show up here.
          </p>
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
        {data.storage === "tiger"
          ? "Stored in Tiger Data."
          : data.storage === "file-fallback"
            ? "Tiger Data did not respond, so this chart is from the local file."
            : "Stored in a local file until DATABASE_URL is set."}
      </p>
      {/* --- ADD AFK WARNING MODAL HERE --- */}
      {isAfk && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            className="panel"
            style={{ textAlign: "center", maxWidth: "350px", padding: "2rem" }}
          >
            <h2 style={{ margin: "0 0 10px 0" }}>🚨 Get Back to Studying!</h2>
            <p>You&apos;ve been inactive for over {afkMinutes} minutes.</p>
            <button
              onClick={() => {
                setIsAfk(false);
                resetTimer();
              }}
              style={{
                marginTop: "1rem",
                padding: "8px 16px",
                cursor: "pointer",
              }}
            >
              I&apos;m Back!
            </button>
          </div>
        </div>
      )}
    </>
  );
}
