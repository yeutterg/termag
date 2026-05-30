import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import os from "node:os";

// Server-side config sanity check. Returns a list of warnings the
// dashboard surfaces as a top banner. The shape is small and stable so
// the client can add new warning types without coordinated deploys.
//
// Warnings are ranked: { level: 'critical' | 'warn' | 'info' }. Critical
// = "your broker is wide-open or near-wide-open"; warn = "this'll bite
// you eventually"; info = "FYI you might want to do X".

export type ConfigWarning = {
  id: string;
  level: "critical" | "warn" | "info";
  title: string;
  detail: string;
  action?: { label: string; href: string } | null;
};

export type HealthStatus = {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  database: {
    status: "connected" | "disconnected" | "error";
    latency?: number;
  };
  warnings: ConfigWarning[];
};

function isLoopbackBind(host: string | undefined): boolean {
  if (!host) {
    return true;
  }
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export const GET = withAuth(async user => {
  const warnings: ConfigWarning[] = [];

  // ── System health metrics ─────────────────────────────────────────────
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  const uptime = process.uptime();

  // ── Database health check ─────────────────────────────────────────────
  let dbStatus: "connected" | "disconnected" | "error" = "disconnected";
  let dbLatency: number | undefined;

  try {
    const dbStartTime = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatency = Date.now() - dbStartTime;
    dbStatus = "connected";
    logger.info("Database health check passed", { latency: dbLatency });
  } catch (error) {
    dbStatus = "error";
    logger.error("Database health check failed", { error });
    warnings.push({
      id: "database-error",
      level: "critical",
      title: "Database connection failed",
      detail: error instanceof Error ? error.message : "Unknown database error",
      action: null,
    });
  }

  // ── trust model warnings ─────────────────────────────────────────────
  const trustedNetwork = process.env.TERMAG_TRUSTED_NETWORK === "true";
  const hostname = process.env.HOSTNAME || "0.0.0.0";
  const hasPassword = Boolean(process.env.TERMAG_PASSWORD);
  if (trustedNetwork && !isLoopbackBind(hostname) && !hasPassword) {
    warnings.push({
      id: "trusted-network-no-password",
      level: "critical",
      title: "Broker is auth-less on a public interface",
      detail: `Bound to ${hostname} with TERMAG_TRUSTED_NETWORK=true and no TERMAG_PASSWORD. Anyone who can reach this host can attach to your sessions.`,
      action: {
        label: "Setup guide",
        href: "https://github.com/yeutterg/termag-next#security-model",
      },
    });
  } else if (trustedNetwork && !hasPassword) {
    warnings.push({
      id: "trusted-network-loopback",
      level: "info",
      title: "Trusted-network mode is on (loopback-only)",
      detail:
        "OK because the bind is loopback. Front it with Tailscale/Caddy/etc. If you expose this URL beyond loopback, also set TERMAG_PASSWORD.",
      action: null,
    });
  }

  // ── SSH setup warnings ───────────────────────────────────────────────
  const hostCount = await prisma.sshHost.count({ where: { userId: user.id } });
  if (hostCount > 0 && !process.env.SSH_AUTH_SOCK) {
    warnings.push({
      id: "ssh-auth-sock-missing",
      level: "warn",
      title: "SSH hosts registered but no ssh-agent socket on the broker",
      detail:
        "SSH_AUTH_SOCK is not set on the broker process. Probes and attaches will only work for hosts whose ~/.ssh/config uses on-disk keys. For agent-forwarded keys, export SSH_AUTH_SOCK before starting the broker (or mount the socket into Docker).",
      action: null,
    });
  }
  const failingHosts = await prisma.sshHost.findMany({
    where: { userId: user.id, lastError: { not: null } },
    select: { id: true, name: true, lastError: true },
  });
  if (failingHosts.length > 0) {
    warnings.push({
      id: "ssh-host-probe-failing",
      level: "warn",
      title: `${failingHosts.length} SSH host${failingHosts.length === 1 ? "" : "s"} failing probe`,
      detail: failingHosts
        .slice(0, 3)
        .map(h => `${h.name}: ${h.lastError}`)
        .join(" · "),
      action: null,
    });
  }

  // ── NextAuth setup warning when OAuth path is chosen ─────────────────
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

  // ── Determine overall health status ───────────────────────────────────
  let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
  const criticalWarnings = warnings.filter(w => w.level === "critical");
  const warnWarnings = warnings.filter(w => w.level === "warn");

  if (criticalWarnings.length > 0 || dbStatus === "error") {
    overallStatus = "unhealthy";
  } else if (warnWarnings.length > 0) {
    overallStatus = "degraded";
  }

  const healthStatus: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    memory: {
      used: memoryUsage.heapUsed,
      total: totalMemory,
      percentage: (memoryUsage.heapUsed / totalMemory) * 100,
    },
    database: {
      status: dbStatus,
      latency: dbLatency,
    },
    warnings,
  };

  logger.info("Health check completed", {
    status: overallStatus,
    warnings: warnings.length,
    dbLatency,
  });

  return NextResponse.json(healthStatus);
});
