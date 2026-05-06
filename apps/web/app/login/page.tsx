import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions, passwordCookieValid, passwordGateEnabled, trustedNetworkEnabled } from '@/lib/auth';
import { LoginButton } from '@/components/login-button';
import { PasswordForm } from '@/components/password-form';

export default async function LoginPage() {
  // Trusted-network with no password gate has nothing to log in to.
  if (trustedNetworkEnabled() && !passwordGateEnabled()) redirect('/');
  // Already authenticated.
  if (passwordGateEnabled() && (await passwordCookieValid())) redirect('/');
  if (!trustedNetworkEnabled()) {
    const session = await getServerSession(authOptions);
    if (session?.user) redirect('/');
  }

  const passwordMode = passwordGateEnabled();

  return (
    <main className="grid h-dvh place-items-center bg-bg px-6 text-text">
      <section className="w-full max-w-sm border border-line bg-panel p-6 shadow-2xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-normal">termag-next</h1>
          <p className="mt-2 text-sm text-muted">
            {passwordMode ? 'Enter the shared password to continue.' : 'Sign in to your personal agent dashboard.'}
          </p>
        </div>
        {passwordMode ? <PasswordForm /> : <LoginButton />}
      </section>
    </main>
  );
}
