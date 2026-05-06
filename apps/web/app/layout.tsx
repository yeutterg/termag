import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { currentUser } from '@/lib/auth';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans'
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono'
});

export const metadata: Metadata = {
  title: 'termag-next',
  description: 'Personal coding-agent dashboard'
};

// Inline boot script paints the right theme before React hydrates so
// users never see a flash of the wrong color scheme.
const themeBootScript = `(function(){try{var t=document.documentElement.dataset.termagTheme||'system';var dark=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dark);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const theme = user?.theme ?? 'system';
  const initialDark = theme === 'dark';

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}${initialDark ? ' dark' : ''}`}
      data-termag-theme={theme}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
