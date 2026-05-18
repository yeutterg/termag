import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { User } from '@prisma/client';
import crypto from 'node:crypto';
import { prisma } from './prisma';

export const PASSWORD_COOKIE = 'termag-auth';

function allowedEmail(): string | null {
  return process.env.TERMAG_ALLOWED_EMAIL?.toLowerCase().trim() || null;
}

function devAuthEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.TERMAG_DEV_AUTH === 'true';
}

/**
 * "Trusted network" mode is opt-in: when enabled, termag assumes it sits
 * behind a private-network ACL (Tailscale, WireGuard, ssh tunnel, etc.)
 * and every request resolves to a single configured user. Set
 * TERMAG_TRUSTED_NETWORK="true" to enable. The default is OAuth — that
 * way a fresh deployment can't accidentally be world-readable.
 *
 * The laptop-agent token path is unaffected either way.
 */
export function trustedNetworkEnabled(): boolean {
  return process.env.TERMAG_TRUSTED_NETWORK === 'true';
}

export function trustedUserEmail(): string {
  return (
    process.env.TERMAG_TRUSTED_USER_EMAIL?.toLowerCase().trim()
    || process.env.TERMAG_ALLOWED_EMAIL?.toLowerCase().trim()
    || 'trusted@termag.local'
  );
}

async function ensureTrustedUser() {
  return prisma.user.upsert({
    where: { email: trustedUserEmail() },
    update: {},
    create: { email: trustedUserEmail(), displayName: 'Trusted User', theme: 'dark' }
  });
}

/**
 * Optional shared-password gate that layers on top of trusted-network mode.
 * Useful when the URL leaks accidentally — won't survive a determined attacker
 * but blocks casual access. Use OAuth for anything public.
 */
export function passwordGateEnabled(): boolean {
  return trustedNetworkEnabled() && Boolean(process.env.TERMAG_PASSWORD);
}

export function passwordCookieValue(): string {
  return crypto.createHash('sha256').update(process.env.TERMAG_PASSWORD || '').digest('hex');
}

function safeTimingEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function checkPassword(provided: string): boolean {
  const expected = process.env.TERMAG_PASSWORD || '';
  return expected.length > 0 && safeTimingEqual(sha256Hex(expected), sha256Hex(provided));
}

export async function passwordCookieValid(): Promise<boolean> {
  if (!passwordGateEnabled()) return true;
  const expected = passwordCookieValue();
  const got = (await cookies()).get(PASSWORD_COOKIE)?.value;
  return Boolean(got && safeTimingEqual(got, expected));
}

function providers() {
  const result: NextAuthOptions['providers'] = [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? ''
    })
  ];

  if (devAuthEnabled()) {
    result.push(
      CredentialsProvider({
        id: 'dev',
        name: 'Dev Preview',
        credentials: {},
        async authorize() {
          const email = process.env.TERMAG_DEV_AUTH_EMAIL?.toLowerCase().trim() || 'preview@termag.local';
          const user = await prisma.user.upsert({
            where: { email },
            update: { displayName: 'Preview User' },
            create: { email, displayName: 'Preview User', theme: 'dark' }
          });
          return {
            id: user.id,
            email: user.email,
            name: user.displayName
          };
        }
      })
    );
  }

  return result;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: providers(),
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === 'dev' && devAuthEnabled()) return true;
      const email = profile?.email?.toLowerCase();
      const allowed = allowedEmail();
      return Boolean(email && allowed && email === allowed);
    },
    async jwt({ token, profile, user: accountUser }) {
      const email = (profile?.email ?? accountUser?.email ?? token.email)?.toLowerCase();
      if (!email) return token;

      const user = await prisma.user.upsert({
        where: { email },
        update: {
          displayName: profile?.name ?? accountUser?.name ?? token.name ?? null,
          image: (profile as { picture?: string } | undefined)?.picture ?? token.picture ?? null
        },
        create: {
          email,
          displayName: profile?.name ?? accountUser?.name ?? token.name ?? null,
          image: (profile as { picture?: string } | undefined)?.picture ?? token.picture ?? null
        }
      });

      token.sub = user.id;
      token.email = user.email;
      token.name = user.displayName;
      token.picture = user.image;
      (token as { theme?: string }).theme = user.theme;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? '';
        session.user.email = token.email ?? '';
        session.user.name = token.name ?? null;
        session.user.image = token.picture ?? null;
        session.user.theme = (token as { theme?: string }).theme ?? 'system';
      }
      return session;
    }
  }
};

export async function currentUser() {
  if (trustedNetworkEnabled()) {
    if (passwordGateEnabled() && !(await passwordCookieValid())) return null;
    return ensureTrustedUser();
  }
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

/**
 * Bearer-token auth for the CLI / non-browser clients. Caller passes the
 * raw token from `Authorization: Bearer …`; if it matches an unrevoked
 * AgentToken row, we return its User. Used by `termag list` and
 * `termag attach` so a CLI on any device with the agent token can reach
 * the broker without a session cookie.
 */
export async function userFromBearerToken(token: string | undefined) {
  if (!token) return null;
  const trimmed = token.trim();
  if (trimmed.length < 16 || trimmed.length > 512) return null;
  // Local import to avoid a top-level cycle (tokens.ts imports nothing).
  const { hashToken } = await import('./tokens');
  const record = await prisma.agentToken.findFirst({
    where: { tokenHash: hashToken(trimmed), revokedAt: null },
    include: { user: true }
  });
  if (!record) return null;
  // Refresh lastUsedAt so the Devices dialog reflects CLI activity too.
  prisma.agentToken.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() }
  }).catch(() => {});
  return record.user;
}

function extractBearerToken(request: Request | { headers: { get(name: string): string | null } }): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function forbidden(reason: string) {
  return NextResponse.json({ error: reason }, { status: 403 });
}

/**
 * Origin-header CSRF check. Mutating methods (POST/PATCH/PUT/DELETE) on a
 * cookie-authenticated request must originate from the same host as the
 * request (or an explicitly allowlisted origin). This shuts the door on
 * cross-site form / fetch attacks even when SameSite=lax cookies are
 * present. Bearer-authenticated calls (CLI) are exempt — they don't ride
 * on cookies so CSRF isn't the threat model.
 *
 * We also honor Sec-Fetch-Site when present (Chromium/Firefox always send
 * it): "same-origin" / "same-site" / "none" (top-level nav) are accepted;
 * "cross-site" is rejected before we even look at Origin.
 */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function isOriginSafe(request: Request): boolean {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return true;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;
  // Chrome sends "same-origin" for fetch(), "same-site" for subdomains.
  // Both are acceptable — same site implies same auth realm here.
  if (fetchSite === 'same-origin' || fetchSite === 'same-site') return true;

  const origin = request.headers.get('origin');
  if (!origin) {
    // No Origin AND no Sec-Fetch-Site means a very old client or a non-browser
    // (curl). Without a Bearer token, we don't trust it for a mutation.
    return false;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const requestHost = request.headers.get('host');
  if (requestHost && originHost === requestHost) return true;

  // Allowlist via TERMAG_ALLOWED_ORIGINS (comma-separated). Same env knob
  // the WS layer uses, so the two stay in sync.
  const allowed = (process.env.TERMAG_ALLOWED_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try { return new URL(entry).host; } catch { return entry.replace(/\/.*/, ''); }
    });
  return allowed.includes(originHost);
}

/**
 * Wraps a route handler with auth: short-circuits to 401 when the user isn't
 * signed in, otherwise calls the inner handler with the resolved User as the
 * first argument. Throwing a Response from a Next.js route handler is treated
 * as a 500, so this wrapper keeps auth flow declarative without throwing.
 *
 * Cookie-authenticated mutations also get a CSRF Origin check before the
 * handler runs. Bearer-authenticated mutations skip it.
 */
export function withAuth<TArgs extends unknown[]>(
  handler: (user: User, ...args: TArgs) => Promise<Response> | Response
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    // Try Bearer token first when a Request is available — keeps the CLI's
    // Authorization header from being defeated by a stray session cookie in
    // some terminal setups. Browser callers don't send Bearer, so they fall
    // through to currentUser() as before.
    const maybeRequest = args.find((arg): arg is Request => arg instanceof Request);
    if (maybeRequest) {
      const token = extractBearerToken(maybeRequest);
      if (token) {
        const tokenUser = await userFromBearerToken(token);
        if (tokenUser) return handler(tokenUser, ...args);
      }
    }
    const user = await currentUser();
    if (!user) return unauthorized();
    if (maybeRequest && !isOriginSafe(maybeRequest)) {
      return forbidden('CSRF check failed: cross-site request blocked');
    }
    return handler(user, ...args);
  };
}
