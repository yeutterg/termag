import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";

export type ConfigWarning = {
  id: string;
  level: "critical" | "warn" | "info";
  title: string;
  detail: string;
  action?: { label: string; href: string } | null;
};

function isLoopbackBind(host: string | undefined): boolean {
  return !host || host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// This endpoint reports static configuration mistakes only. Runtime liveness is
// already carried by the agent WebSocket, so polling the database and process
// metrics from every browser was duplicate work.
export const GET = withAuth(async () => {
  const warnings: ConfigWarning[] = [];
  const trustedNetwork = process.env.TERMINALZ_TRUSTED_NETWORK === "true";
  const hostname = process.env.HOSTNAME || "0.0.0.0";
  const hasPassword = Boolean(process.env.TERMINALZ_PASSWORD);

  if (trustedNetwork && !isLoopbackBind(hostname) && !hasPassword) {
    warnings.push({
      id: "trusted-network-no-password",
      level: "critical",
      title: "Broker is auth-less on a public interface",
      detail: `Bound to ${hostname} with TERMINALZ_TRUSTED_NETWORK=true and no TERMINALZ_PASSWORD. Anyone who can reach this host can attach to your sessions.`,
      action: {
        label: "Setup guide",
        href: "https://github.com/yeutterg/terminalz#security-model",
      },
    });
  } else if (trustedNetwork && !hasPassword) {
    warnings.push({
      id: "trusted-network-loopback",
      level: "info",
      title: "Trusted-network mode is on (loopback-only)",
      detail:
        "This is safe while the broker remains loopback-only. Add TERMINALZ_PASSWORD before exposing it beyond a private proxy.",
      action: null,
    });
  }

  if (!trustedNetwork && !process.env.NEXTAUTH_SECRET) {
    warnings.push({
      id: "nextauth-secret-missing",
      level: "critical",
      title: "NEXTAUTH_SECRET is not set",
      detail:
        "OAuth mode requires NEXTAUTH_SECRET to sign session tokens. Generate one with `openssl rand -hex 32` and restart the broker.",
      action: null,
    });
  }

  return NextResponse.json({ warnings });
});
