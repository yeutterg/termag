import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { LoginButton } from '@/components/login-button';

export default async function LoginPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) redirect('/');

  return (
    <main className="grid h-dvh place-items-center bg-bg px-6 text-text">
      <section className="w-full max-w-sm border border-line bg-panel p-6 shadow-2xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-normal">termag</h1>
          <p className="mt-2 text-sm text-muted">Sign in to your personal agent dashboard.</p>
        </div>
        <LoginButton />
      </section>
    </main>
  );
}
