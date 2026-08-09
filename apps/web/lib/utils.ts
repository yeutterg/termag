import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const STATUS_LABELS: Record<string, string> = {
  blocked: "Blocked",
  done: "Done",
  idle: "Idle",
  working: "Working",
  unknown: "Unknown",
  offline: "Offline",
  waiting: "Waiting",
  error: "Error",
  sleeping: "Sleeping",
};

const STATUS_DOTS: Record<string, string> = {
  blocked: "bg-bad",
  done: "bg-done",
  idle: "bg-good",
  working: "bg-work",
  unknown: "bg-muted",
  offline: "bg-muted",
  waiting: "bg-warn",
  error: "bg-bad",
  sleeping: "bg-muted",
};

export function statusLabel(status?: string) {
  return STATUS_LABELS[status ?? ""] ?? STATUS_LABELS.sleeping;
}

export function statusDot(status?: string) {
  return STATUS_DOTS[status ?? ""] ?? STATUS_DOTS.sleeping;
}
