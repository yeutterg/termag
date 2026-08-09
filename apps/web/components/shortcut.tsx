"use client";

import { createContext, type ReactNode, useContext } from "react";
import { Kbd } from "./kbd";
import type { Platform } from "@/lib/platform";

export type ChordKey =
  | "mod" // ⌘ on Mac, Ctrl elsewhere
  | "alt" // ⌥ on Mac, Alt elsewhere
  | "shift"
  | "ctrl" // literal Control even on Mac (e.g. Ctrl+Tab)
  | "enter"
  | "esc"
  | "tab"
  | "backspace"
  | "delete"
  | string; // anything else passes through verbatim

const PlatformContext = createContext<Platform>({ isMac: true, showShortcuts: true });

export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

const MAC_GLYPHS: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
  ctrl: "⌃",
  enter: "↵",
  esc: "Esc",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
};

const WIN_LABELS: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  ctrl: "Ctrl",
  enter: "Enter",
  esc: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
};

function formatShortcut(keys: ChordKey[], isMac: boolean): string {
  if (isMac) {
    return keys.map(key => MAC_GLYPHS[key] ?? key).join("");
  }
  return keys.map(key => WIN_LABELS[key] ?? key).join("+");
}

export function shortcutSuffix(keys: ChordKey[], platform: Platform): string {
  if (!platform.showShortcuts) {
    return "";
  }
  return ` (${formatShortcut(keys, platform.isMac)})`;
}

/** Renders nothing on mobile; on desktop renders a Kbd with platform glyphs. */
export function Shortcut({ keys }: { keys: ChordKey[] }) {
  const platform = useContext(PlatformContext);
  if (!platform.showShortcuts) {
    return null;
  }
  return <Kbd>{formatShortcut(keys, platform.isMac)}</Kbd>;
}
