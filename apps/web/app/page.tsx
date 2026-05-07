import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser, passwordGateEnabled, trustedNetworkEnabled } from '@/lib/auth';
import { listProjects } from '@/lib/projects';
import { parseRoots } from '@/lib/defaults';
import { detectPlatformFromUserAgent } from '@/lib/platform';
import { TermagApp } from '@/components/termag-app';

// Per-request render — depends on session, headers, and DB. Prerendering
// at build would call Prisma against an unconfigured container.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const [projects, headerList] = await Promise.all([listProjects(user.id), headers()]);
  const platform = detectPlatformFromUserAgent(headerList.get('user-agent'));
  const authMode: 'oauth' | 'password' | 'trusted' = trustedNetworkEnabled()
    ? (passwordGateEnabled() ? 'password' : 'trusted')
    : 'oauth';
  return (
    <TermagApp
      user={{ id: user.id, email: user.email, name: user.displayName, theme: user.theme }}
      initialProjects={JSON.parse(JSON.stringify(projects))}
      roots={parseRoots()}
      platform={platform}
      authMode={authMode}
    />
  );
}
