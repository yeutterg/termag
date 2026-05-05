import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { getServerSession } from 'next-auth';
import { prisma } from './prisma';

function allowedEmail(): string | null {
  return process.env.TERMAG_ALLOWED_EMAIL?.toLowerCase().trim() || null;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? ''
    })
  ],
  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      const allowed = allowedEmail();
      return Boolean(email && allowed && email === allowed);
    },
    async jwt({ token, profile }) {
      const email = (profile?.email ?? token.email)?.toLowerCase();
      if (!email) return token;

      const user = await prisma.user.upsert({
        where: { email },
        update: {
          displayName: profile?.name ?? token.name ?? null,
          image: (profile as { picture?: string } | undefined)?.picture ?? token.picture ?? null
        },
        create: {
          email,
          displayName: profile?.name ?? token.name ?? null,
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
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) {
    throw new Response('Unauthorized', { status: 401 });
  }
  return user;
}
