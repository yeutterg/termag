import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { listProjects } from '@/lib/projects';
import { parseRoots } from '@/lib/defaults';
import { TermagApp } from '@/components/termag-app';

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const projects = await listProjects(user.id);
  return (
    <TermagApp
      user={{ id: user.id, email: user.email, name: user.displayName, theme: user.theme }}
      initialProjects={JSON.parse(JSON.stringify(projects))}
      roots={parseRoots()}
    />
  );
}
