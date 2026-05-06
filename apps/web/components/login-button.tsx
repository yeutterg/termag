'use client';

import { signIn } from 'next-auth/react';

export function LoginButton({ showDevLogin }: { showDevLogin: boolean }) {
  return (
    <div className="space-y-2">
      <button
        className="h-10 w-full border border-line bg-panel2 px-3 text-sm font-medium hover:bg-bg"
        onClick={() => signIn('google', { callbackUrl: '/' })}
      >
        Sign in with Google
      </button>
      {showDevLogin && (
        <button
          className="h-10 w-full border border-line bg-bg px-3 text-sm font-medium text-muted hover:bg-panel2 hover:text-text"
          onClick={() => signIn('dev', { callbackUrl: '/' })}
        >
          Dev preview login
        </button>
      )}
    </div>
  );
}
