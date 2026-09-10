"use client";

import { useEffect, useState } from "react";
import { MirroredTerminalLayout } from "./mirrored-terminal-layout";
import type { Tab } from "./types";

const ignoreTitle = () => {};

export function NativeTerminal({ tabs }: { tabs: Tab[] }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    root.classList.add("dark");
    root.dataset.terminalzNative = "true";
    // Mount after the native viewport and appearance have been applied.
    const frame = requestAnimationFrame(() => setReady(true));
    return () => {
      cancelAnimationFrame(frame);
      root.classList.toggle("dark", wasDark);
      delete root.dataset.terminalzNative;
    };
  }, []);
  return (
    <main className="flex h-full min-h-0 bg-[#0a0a0a]" aria-label="Terminal">
      {ready && (
        <MirroredTerminalLayout tabs={tabs} connected liveTitles={{}} onTitleChange={ignoreTitle} />
      )}
    </main>
  );
}
