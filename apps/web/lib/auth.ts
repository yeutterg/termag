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
 * "Trusted network" mode is on by default: termag assumes it sits behind a
 * private-network ACL (Tailscale, WireGuard, ssh tunnel, etc.) and every
 * request resolves to a single configured user. Set TERMAG_TRUSTED_NETWORK
 * to "false" to opt into OAuth instead. The laptop-agent token path is
 * unaffected either way.
 */
export function trustedNetworkEnabled(): boolean {
  return process.env.TERMAG_TRUSTED_NETWORK !== 'false';
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

export function checkPassword(provided: string): boolean {
  const expected = process.env.TERMAG_PASSWORD || '';
  if (expected.length === 0 || expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export async function passwordCookieValid(): Promise<boolean> {
  if (!passwordGateEnabled()) return true;
  const expected = passwordCookieValue();
  const got = (await cookies()).get(PASSWORD_COOKIE)?.value;
  if (!got || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
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

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Wraps a route handler with auth: short-circuits to 401 when the user isn't
 * signed in, otherwise calls the inner handler with the resolved User as the
 * first argument. Throwing a Response from a Next.js route handler is treated
 * as a 500, so this wrapper keeps auth flow declarative without throwing.
 */
export function withAuth<TArgs extends unknown[]>(
  handler: (user: User, ...args: TArgs) => Promise<Response> | Response
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    const user = await currentUser();
    if (!user) return unauthorized();
    return handler(user, ...args);
  };
}
