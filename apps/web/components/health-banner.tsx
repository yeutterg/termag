"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ConfigWarning = {
  id: string;
  level: "critical" | "warn" | "info";
  title: string;
  detail: string;
  action?: { label: string; href: string } | null;
};

// Loads static configuration warnings once and renders them at the top of the
// dashboard. The user can dismiss individual warnings
// for the session via localStorage — dismissals are not server-persisted
// since the underlying condition will re-surface on the next reload (and
// usually merits attention again anyway).

const DISMISS_STORAGE_KEY = "termag.health.dismissed.v1";

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

export function HealthBanner() {
  const [warnings, setWarnings] = useState<ConfigWarning[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setDismissed(readDismissed());
      }
    });
    async function load() {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) {
          return;
        }
        const body = await res.json();
        if (!cancelled && Array.isArray(body?.warnings)) {
          setWarnings(body.warnings);
        }
      } catch {
        // Silent — banner just stays empty.
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    writeDismissed(next);
  }

  const visible = warnings.filter(w => !dismissed.includes(w.id));
  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-line bg-bg px-3 py-2">
      {visible.map(w => (
        <div
          key={w.id}
          role={w.level === "critical" ? "alert" : "note"}
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
            w.level === "critical" && "border-bad/40 bg-bad/10 text-bad",
            w.level === "warn" && "border-warn/40 bg-warn/10 text-warn",
            w.level === "info" && "border-line bg-panel2 text-muted"
          )}
        >
          <span className="mt-0.5 shrink-0">
            {w.level === "critical" ? (
              <ShieldAlert className="h-3.5 w-3.5" />
            ) : w.level === "warn" ? (
              <AlertTriangle className="h-3.5 w-3.5" />
            ) : (
              <Info className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{w.title}</div>
            <div className="mt-0.5 break-words text-muted">{w.detail}</div>
            {w.action && (
              <a
                href={w.action.href}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block underline underline-offset-2"
              >
                {w.action.label}
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismiss(w.id)}
            className="-mr-1 shrink-0 rounded-md p-1 text-muted hover:text-text"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
