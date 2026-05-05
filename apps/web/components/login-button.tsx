'use client';

import { signIn } from 'next-auth/react';

export function LoginButton() {
  return (
    <button
      className="h-10 w-full border border-line bg-panel2 px-3 text-sm font-medium hover:bg-bg"
      onClick={() => signIn('google', { callbackUrl: '/' })}
    >
      Sign in with Google
    </button>
  );
}
