import type { Metadata, Viewport } from "next";
import { Geist, DM_Mono } from "next/font/google";
import { currentUser } from "@/lib/auth";
import { ClientRuntime } from "@/components/client-runtime";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "termag-next",
  description: "Personal coding-agent dashboard",
  applicationName: "Termag",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Termag",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
  interactiveWidget: "resizes-visual",
};

// Inline boot script paints the right theme before React hydrates so
// users never see a flash of the wrong color scheme.
const themeBootScript = `(function(){try{var t=document.documentElement.dataset.termagTheme||'system';var dark=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dark);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const theme = user?.theme ?? "system";
  const initialDark = theme === "dark";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${dmMono.variable}${initialDark ? " dark" : ""}`}
      data-termag-theme={theme}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <ClientRuntime />
        {children}
      </body>
    </html>
  );
}
