"use client";

/**
 * Small presentational pieces shared by the panel.
 *
 * Kept in one file because each is a handful of lines and they are always used
 * together; a directory of one-component modules would be noise.
 */

import { useEffect, useRef, useState } from "react";

export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-lg border border-[var(--color-panel-line)] bg-[var(--color-panel-surface)] ${className}`}
    >
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-panel-line)] px-4 py-2.5">
          <h2 className="text-[0.8rem] font-semibold tracking-wide text-[var(--color-panel-dim)] uppercase">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className="dot" data-status={status} aria-hidden="true" />;
}

export function Badge({ children, tone = "dim" }: { children: React.ReactNode; tone?: "dim" | "good" | "warn" | "bad" }) {
  const colours: Record<string, string> = {
    dim: "text-[var(--color-panel-dim)] border-[var(--color-panel-line)]",
    good: "text-[var(--color-panel-good)] border-[var(--color-panel-good)]/40",
    warn: "text-[var(--color-panel-warn)] border-[var(--color-panel-warn)]/40",
    bad: "text-[var(--color-panel-bad)] border-[var(--color-panel-bad)]/40",
  };
  return (
    <span
      className={`inline-block rounded border px-1.5 py-px font-mono text-[0.68rem] leading-tight ${colours[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A device-width toggle for the preview frames.
 *
 * The widths are the two that matter for judging a reconstruction, and they are
 * the ones used for the source screenshots, so the two sides are comparable.
 */
export function ViewportPicker({
  value,
  onChange,
}: {
  value: "desktop" | "mobile";
  onChange: (v: "desktop" | "mobile") => void;
}) {
  const options = [
    { id: "desktop" as const, label: "Desktop", width: 1440 },
    { id: "mobile" as const, label: "Mobile", width: 390 },
  ];
  return (
    <div className="flex overflow-hidden rounded border border-[var(--color-panel-line)] text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`px-2.5 py-1 transition-colors ${
            value === o.id
              ? "bg-[var(--color-panel-accent)] text-black"
              : "text-[var(--color-panel-dim)] hover:bg-[var(--color-panel-raised)]"
          }`}
        >
          {o.label}
          <span className="ml-1.5 opacity-60">{o.width}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * An iframe that reloads whenever `reloadKey` changes.
 *
 * A generated site is a fresh `next start` process after a rebuild, so the old
 * document is genuinely stale. Remounting via `key` is the only reliable way to
 * force a new document; a src change alone is not enough when the path is the
 * same.
 */
export function DeviceFrame({
  src,
  title,
  reloadKey,
  width,
  note,
}: {
  src: string | null;
  title: string;
  reloadKey: number;
  width: number;
  note?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!src) return;
    setState("loading");
    setNonce((n) => n + 1);
  }, [src, reloadKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
        <span className="truncate text-[var(--color-panel-dim)]">{title}</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[0.68rem] text-[var(--color-panel-dim)]">
            {state === "ready" ? "loaded" : state === "loading" ? "loading…" : state === "error" ? "unavailable" : note ?? ""}
          </span>
          {src ? (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the generated site in a full browser tab"
              className="font-mono text-[0.68rem] text-[var(--color-panel-dim)] transition-colors hover:text-[var(--color-panel-accent)]"
            >
              open ↗
            </a>
          ) : null}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-[var(--color-panel-raised)]">
        {src ? (
          <iframe
            key={`${src}-${nonce}`}
            src={src}
            title={title}
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
            // A generated site is untrusted third-party-derived content. It is
            // sandboxed, and same-origin access is withheld so it cannot reach
            // the panel's own session or API.
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
            style={{ width: width > 640 ? "100%" : width, maxWidth: "100%", margin: "0 auto" }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-[var(--color-panel-dim)]">
            {note ?? "Not running."}
          </div>
        )}
      </div>
    </div>
  );
}

/** Copy-to-clipboard button with inline confirmation. */
export function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      className="rounded border border-[var(--color-panel-line)] px-2 py-0.5 font-mono text-[0.68rem] text-[var(--color-panel-dim)] transition-colors hover:bg-[var(--color-panel-raised)] hover:text-[var(--color-panel-text)]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked (insecure origin); the code panel is selectable anyway */
        }
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-[var(--color-panel-dim)]">
      {children}
    </div>
  );
}
