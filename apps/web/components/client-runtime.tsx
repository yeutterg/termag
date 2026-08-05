"use client";

import { useEffect } from "react";

/** Browser-only platform wiring kept out of the dashboard bundle's state. */
export function ClientRuntime() {
  useEffect(() => {
    let frame = 0;
    const updateViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = window.visualViewport?.height ?? window.innerHeight;
        document.documentElement.style.setProperty(
          "--termag-viewport-height",
          `${Math.max(1, Math.round(height))}px`
        );
      });
    };

    updateViewport();
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("orientationchange", updateViewport);
    window.addEventListener("resize", updateViewport);

    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(error => {
        console.warn("[termag] service worker registration failed", error);
      });
    }

    return () => {
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("orientationchange", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  return null;
}
