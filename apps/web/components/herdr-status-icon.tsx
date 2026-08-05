import { cn } from "@/lib/utils";

const STATUS = {
  blocked: { dot: "●", symbol: "×", color: "text-bad", label: "Blocked" },
  working: { dot: "●", symbol: "◐", color: "text-warn", label: "Working" },
  done: { dot: "●", symbol: "✓", color: "text-done", label: "Done" },
  idle: { dot: "○", symbol: "○", color: "text-good", label: "Idle" },
  unknown: { dot: "·", symbol: "·", color: "text-muted", label: "Unknown" },
  offline: { dot: "·", symbol: "·", color: "text-muted", label: "Offline" },
} as const;

export function HerdrStatusIcon({
  status,
  variant = "dot",
  className,
}: {
  status?: string;
  variant?: "dot" | "symbol";
  className?: string;
}) {
  const item = STATUS[(status && status in STATUS ? status : "unknown") as keyof typeof STATUS];
  return (
    <span
      className={cn(
        "inline-grid h-4 w-4 shrink-0 place-items-center font-mono text-sm leading-none",
        item.color,
        className
      )}
      title={item.label}
      aria-label={item.label}
    >
      {item[variant]}
    </span>
  );
}
