"use client";

/**
 * The control panel.
 *
 * The whole demo is driven from this one page: give it a URL, watch the
 * pipeline report what it is doing over SSE, look at the result at desktop and
 * mobile widths next to the source, and apply a change in plain English.
 *
 * It is a single client component on purpose. The state that matters - the
 * selected project, the live event log, the preview port, the viewport toggle -
 * is all cross-cutting, and splitting it across a component tree would add
 * indirection without adding structure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, CopyButton, DeviceFrame, Empty, Panel, StatusDot, ViewportPicker } from "./panel-ui";

/* ------------------------------------------------------------- wire types */

type RunStatus =
  | "queued" | "analyzing" | "spec" | "generating" | "building"
  | "ready" | "modifying" | "failed" | "cancelled";

interface RunEvent {
  at: string;
  status: RunStatus;
  message: string;
  model?: string;
  data?: Record<string, unknown>;
}

interface Modification {
  id: string;
  request: string;
  at: string;
  model: string;
  summary: string;
  changeSummary: string;
  applied: boolean;
  error?: string;
}

interface Project {
  id: string;
  sourceUrl: string;
  finalUrl: string;
  title: string;
  status: RunStatus;
  createdAt: string;
  modelTrail: string[];
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  build?: { ok: boolean; durationMs: number; attempts: number; errors: string[] };
  sectionCount: number;
  sectionKinds: string[];
  assets: { downloaded: number; missing: number; total: number };
  modifications: Modification[];
  error?: string;
  previewPort?: number;
}

interface ModelInfo {
  provider: string;
  discovered: number;
  free: number;
  primary: string | null;
  discoveredAt: string;
  pricingAvailable: boolean;
  error?: string;
  models?: { id: string; name: string; verifiablyFree: boolean; contextWindow: number | null }[];
}

const TERMINAL = new Set<RunStatus>(["ready", "failed", "cancelled"]);

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

function elapsed(from: string, to?: string): string {
  const a = new Date(from).getTime();
  const b = to ? new Date(to).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/* ------------------------------------------------------------------- app */

export default function ControlPanel() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ project: Project; spec: unknown } | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [models, setModels] = useState<ModelInfo | null>(null);

  const [url, setUrl] = useState("");
  const [request, setRequest] = useState("");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(true);

  const logRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------------------------------------------ data I/O */

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      const data = (await res.json()) as { projects: Project[] };
      setProjects(data.projects);
      setSelected((cur) => cur ?? data.projects[0]?.id ?? null);
      return data.projects;
    } catch {
      return [];
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/projects/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { project: Project; spec: unknown };
    setDetail(data);
  }, []);

  useEffect(() => {
    void refreshList();
    fetch("/api/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((m: ModelInfo) => setModels(m))
      .catch(() => undefined);
  }, [refreshList]);

  // Selection drives both the record and the event stream.
  useEffect(() => {
    if (!selected) return;
    setEvents([]);
    void refreshDetail(selected);
  }, [selected, refreshDetail]);

  // Live progress. EventSource reconnects on its own, and the server replays
  // the run's history on every connection, so a dropped stream self-heals.
  useEffect(() => {
    if (!selected) return;
    const source = new EventSource(`/api/projects/${selected}/events`);
    const onEvent = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as RunEvent;
        setEvents((prev) => (prev.some((p) => p.at === event.at && p.message === event.message) ? prev : [...prev, event]));
        if (TERMINAL.has(event.status)) {
          // Final state: close the stream before reloading the record, or the
          // browser will redial and replay the same events.
          source.close();
          void refreshDetail(selected);
          void refreshList();
        }
      } catch {
        /* a malformed frame must not break the log */
      }
    };
    source.addEventListener("message", onEvent);
    return () => source.close();
  }, [selected, refreshDetail, refreshList]);

  // Keep the log pinned to the newest line while it is open and scrolled down.
  useEffect(() => {
    const el = logRef.current;
    if (!el || !logOpen) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [events, logOpen]);

  /* ------------------------------------------------------------- actions */

  // Start a run for a URL and switch the panel to it. Shared by the clone
  // form and the retry button so a failed run is restarted the same way.
  const startRun = useCallback(
    async (targetUrl: string): Promise<boolean> => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: targetUrl }),
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !data.id) {
          setError(data.error ?? "Could not start that run.");
          return false;
        }
        setSelected(data.id);
        setEvents([]);
        setLogOpen(true);
        await refreshList();
        return true;
      } catch {
        setError("The control panel could not reach its own API.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refreshList],
  );

  const startGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await startRun(url)) setUrl("");
  };

  const retryProject = () => {
    const failed = detail?.project;
    if (!failed || failed.status !== "failed") return;
    void startRun(failed.sourceUrl);
  };

  const startPreview = async (id: string, on: boolean) => {
    setError(null);
    const res = await fetch(`/api/projects/${id}/preview`, { method: on ? "POST" : "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "The preview server could not be started.");
      return;
    }
    // A new process means a new document; the frame has to be remounted.
    setReloadKey((k) => k + 1);
    await refreshDetail(id);
  };

  const sendModify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${selected}/modify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That change could not be applied.");
        return;
      }
      setRequest("");
      setEvents([]);
      setLogOpen(true);
    } catch {
      setError("The control panel could not reach its own API.");
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (selected === id) setSelected(null);
      setDetail(null);
      await refreshList();
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- view */

  const project = detail?.project ?? null;
  const running = project ? !TERMINAL.has(project.status) : false;
  const previewUrl = project?.previewPort ? `http://127.0.0.1:${project.previewPort}/` : null;
  const frameWidth = viewport === "desktop" ? 1440 : 390;

  const lastModification = useMemo(
    () => (project?.modifications ?? []).slice(-1)[0] ?? null,
    [project],
  );

  const spec = detail?.spec as
    | {
        theme?: { tokens?: Record<string, string>; fonts?: Record<string, unknown> };
        sections?: { id: string; kind: string; name: string; intent: string; heading?: { text: string } }[];
        nav?: { links?: unknown[] };
        footer?: { columns?: unknown[] };
      }
    | null;

  return (
    <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col gap-3 p-3">
      {/* ---------------------------------------------------------- header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Sitewright</h1>
          <p className="text-xs text-[var(--color-panel-dim)]">
            URL in, standalone React/Next.js project out. Structure is measured in a browser; the model only
            interprets it.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {models ? (
            models.error ? (
              <Badge tone="bad">models unavailable</Badge>
            ) : (
              <>
                <Badge>{models.provider}</Badge>
                <Badge tone="good">{models.free} free of {models.discovered} discovered</Badge>
                {models.primary ? <Badge tone="good">{models.primary}</Badge> : null}
              </>
            )
          ) : (
            <Badge>checking models…</Badge>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------ error */}
      {error ? (
        <div
          role="alert"
          className="rounded border border-[var(--color-panel-bad)]/50 bg-[var(--color-panel-bad)]/10 px-3 py-2 text-sm text-[var(--color-panel-bad)]"
        >
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[19rem_minmax(0,1fr)]">
        {/* ------------------------------------------------------- sidebar */}
        <div className="flex min-h-0 flex-col gap-3">
          <Panel title="New clone">
            <form onSubmit={startGenerate} className="flex flex-col gap-2 p-3">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="example.com"
                // type=url gives free validation; the API validates properly too.
                type="url"
                required
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border border-[var(--color-panel-line)] bg-[var(--color-panel-bg)] px-2.5 py-1.5 font-mono text-sm outline-none placeholder:text-[var(--color-panel-dim)]/60 focus:border-[var(--color-panel-accent)]"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-[var(--color-panel-accent)] px-3 py-1.5 text-sm font-medium text-black transition-opacity disabled:opacity-50"
              >
                {busy ? "Working…" : "Clone this site"}
              </button>
              <p className="text-[0.68rem] leading-snug text-[var(--color-panel-dim)]">
                Crawl, extract, interpret, generate, build and validate. About one to three minutes.
              </p>
            </form>
          </Panel>

          <Panel title="Runs" className="min-h-0 flex-1">
            <div className="log min-h-0 flex-1 overflow-y-auto">
              {projects.length === 0 ? (
                <Empty>No runs yet.</Empty>
              ) : (
                <ul>
                  {projects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(p.id)}
                        className={`flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                          selected === p.id
                            ? "border-l-[var(--color-panel-accent)] bg-[var(--color-panel-raised)]"
                            : "border-l-transparent hover:bg-[var(--color-panel-raised)]"
                        }`}
                      >
                        <span className="pt-1">
                          <StatusDot status={p.status} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{hostOf(p.finalUrl || p.sourceUrl)}</span>
                          <span className="block truncate font-mono text-[0.68rem] text-[var(--color-panel-dim)]">
                            {p.status} · {p.sectionCount} sections
                            {p.assets.downloaded ? ` · ${p.assets.downloaded} assets` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>

        {/* ---------------------------------------------------------- main */}
        <div className="flex min-h-0 flex-col gap-3">
          {!project ? (
            <Panel className="flex-1">
              <Empty>Clone a URL to begin. Every step reports below.</Empty>
            </Panel>
          ) : (
            <>
              {/* summary strip */}
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot status={project.status} />
                      <span className="truncate text-sm font-medium">
                        {project.title || hostOf(project.finalUrl || project.sourceUrl)}
                      </span>
                      <Badge>{project.status}</Badge>
                      {running ? <Badge tone="good">running</Badge> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.68rem] text-[var(--color-panel-dim)]">
                      <span title="The URL that was cloned">{project.finalUrl || project.sourceUrl}</span>
                      {project.modelTrail.length ? <span>model {project.modelTrail.join(" → ")}</span> : null}
                      <span>{project.aiCalls} model calls</span>
                      {project.inputTokens || project.outputTokens ? (
                        <span>
                          {project.inputTokens.toLocaleString()} in / {project.outputTokens.toLocaleString()} out
                        </span>
                      ) : null}
                      {project.build ? (
                        <span className={project.build.ok ? "text-[var(--color-panel-good)]" : "text-[var(--color-panel-bad)]"}>
                          build {project.build.ok ? "ok" : "failed"} in {(project.build.durationMs / 1000).toFixed(1)}s
                          {project.build.attempts > 1 ? ` after ${project.build.attempts} attempts` : ""}
                        </span>
                      ) : null}
                      <span>
                        {project.assets.downloaded}/{project.assets.total} assets
                        {project.assets.missing ? ` (${project.assets.missing} unavailable)` : ""}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ViewportPicker value={viewport} onChange={setViewport} />
                    <button
                      type="button"
                      onClick={() => startPreview(project.id, !previewUrl)}
                      disabled={running}
                      className="rounded border border-[var(--color-panel-line)] px-2.5 py-1 text-xs transition-colors hover:bg-[var(--color-panel-raised)] disabled:opacity-40"
                    >
                      {previewUrl ? "Stop preview" : "Start preview"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReloadKey((k) => k + 1)}
                      disabled={!previewUrl}
                      className="rounded border border-[var(--color-panel-line)] px-2.5 py-1 text-xs transition-colors hover:bg-[var(--color-panel-raised)] disabled:opacity-40"
                    >
                      Reload
                    </button>
                    {project.status === "failed" ? (
                      <button
                        type="button"
                        onClick={retryProject}
                        disabled={busy}
                        title={`Retry cloning ${project.sourceUrl}`}
                        className="rounded border border-[var(--color-panel-accent)] px-2.5 py-1 text-xs text-[var(--color-panel-accent)] transition-colors hover:bg-[var(--color-panel-accent)]/10 disabled:opacity-40"
                      >
                        ↻ Retry
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeProject(project.id)}
                      className="rounded border border-[var(--color-panel-line)] px-2.5 py-1 text-xs text-[var(--color-panel-bad)] transition-colors hover:bg-[var(--color-panel-bad)]/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {project.error ? (
                  <p className="border-t border-[var(--color-panel-line)] px-4 py-2 text-xs text-[var(--color-panel-bad)]">
                    {project.error}
                  </p>
                ) : null}
              </Panel>

              {/* previews + modify */}
              <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
                <Panel
                  title="Generated site"
                  className="min-h-[26rem] h-[min(70dvh,56rem)]"
                  right={
                    previewUrl ? (
                      <span className="font-mono text-[0.68rem] text-[var(--color-panel-dim)]">{previewUrl}</span>
                    ) : null
                  }
                >
                  <DeviceFrame
                    src={previewUrl}
                    title={`Clone at ${frameWidth}px`}
                    reloadKey={reloadKey}
                    width={frameWidth}
                    note={running ? "Waiting for the build to finish…" : "Start the preview to view it."}
                  />
                </Panel>

                <div className="flex min-h-0 flex-col gap-3">
                  <Panel title="Change it">
                    <form onSubmit={sendModify} className="flex flex-col gap-2 p-3">
                      <textarea
                        value={request}
                        onChange={(e) => setRequest(e.target.value)}
                        rows={3}
                        maxLength={2000}
                        placeholder="Make the hero heading navy and drop the third pricing tier"
                        className="w-full resize-y rounded border border-[var(--color-panel-line)] bg-[var(--color-panel-bg)] px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--color-panel-dim)]/60 focus:border-[var(--color-panel-accent)]"
                      />
                      <button
                        type="submit"
                        disabled={busy || running || !request.trim()}
                        className="rounded bg-[var(--color-panel-raised)] px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-panel-line)] disabled:opacity-40"
                      >
                        {running ? "Busy…" : "Apply change"}
                      </button>
                      {lastModification ? (
                        <div className="rounded border border-[var(--color-panel-line)] bg-[var(--color-panel-bg)] p-2 text-[0.7rem] leading-snug">
                          <div className="flex items-center gap-1.5">
                            <Badge tone={lastModification.applied ? "good" : "bad"}>
                              {lastModification.applied ? "applied" : "rejected"}
                            </Badge>
                            <span className="font-mono text-[var(--color-panel-dim)]">
                              {lastModification.model} · {timeOf(lastModification.at)}
                            </span>
                          </div>
                          <p className="mt-1 text-[var(--color-panel-text)]">
                            &ldquo;{lastModification.request}&rdquo;
                          </p>
                          {lastModification.changeSummary ? (
                            <p className="mt-1 text-[var(--color-panel-dim)]">{lastModification.changeSummary}</p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-[0.68rem] leading-snug text-[var(--color-panel-dim)]">
                          Applied as a patch against the spec, then only the affected files are rebuilt. It is not a
                          fresh clone.
                        </p>
                      )}
                    </form>
                  </Panel>

                  <Panel title="Spec" className="min-h-0 flex-1">
                    <div className="log min-h-0 flex-1 overflow-y-auto p-3">
                      {spec ? (
                        <>
                          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[0.7rem]">
                            {Object.entries(spec.theme?.tokens ?? {}).map(([k, v]) => (
                              <div key={k} className="contents">
                                <dt className="text-[var(--color-panel-dim)]">{k}</dt>
                                <dd className="flex items-center gap-1.5">
                                  <span
                                    className="inline-block h-2.5 w-2.5 rounded-sm border border-[var(--color-panel-line)]"
                                    style={{ background: v }}
                                    aria-hidden="true"
                                  />
                                  {v}
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <ol className="mt-3 space-y-1.5">
                            {(spec.sections ?? []).map((s) => (
                              <li key={s.id} className="border-l-2 border-[var(--color-panel-line)] pl-2">
                                <div className="flex items-center gap-1.5">
                                  <Badge>{s.kind}</Badge>
                                  <span className="truncate text-xs">{s.heading?.text || s.name}</span>
                                </div>
                                <p className="mt-0.5 text-[0.68rem] leading-snug text-[var(--color-panel-dim)]">
                                  {s.intent}
                                </p>
                              </li>
                            ))}
                          </ol>
                          <div className="mt-3">
                            <CopyButton value={JSON.stringify(spec, null, 2)} label="copy spec JSON" />
                          </div>
                        </>
                      ) : (
                        <Empty>{running ? "Written once the spec exists." : "No spec for this run."}</Empty>
                      )}
                    </div>
                  </Panel>
                </div>
              </div>

              {/* log */}
              <Panel
                title="Progress"
                right={
                  <button
                    type="button"
                    onClick={() => setLogOpen((v) => !v)}
                    className="font-mono text-[0.68rem] text-[var(--color-panel-dim)] hover:text-[var(--color-panel-text)]"
                  >
                    {logOpen ? "hide" : "show"}
                  </button>
                }
              >
                {logOpen ? (
                  <div
                    ref={logRef}
                    className="log h-56 shrink-0 overflow-y-auto px-3 py-2 font-mono text-[0.7rem] [scrollbar-gutter:stable]"
                  >
                    {events.length === 0 ? (
                      <p className="text-[var(--color-panel-dim)]">Waiting for the first event…</p>
                    ) : (
                      <ol className="space-y-0.5">
                        {events.map((ev, i) => (
                          <li key={`${ev.at}-${i}`} className="flex gap-2">
                            <span className="shrink-0 text-[var(--color-panel-dim)]">{timeOf(ev.at)}</span>
                            <span className="w-24 shrink-0 text-[var(--color-panel-accent)]">{ev.status}</span>
                            <span className="min-w-0 flex-1 break-words">{ev.message}</span>
                            {ev.model ? (
                              <span className="shrink-0 text-[var(--color-panel-dim)]">{ev.model}</span>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ) : null}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "unknown";
  }
}
