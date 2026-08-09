"use client";

import { useEffect } from "react";

/** Browser-only platform wiring kept out of the dashboard bundle's state. */
export function ClientRuntime() {
  useEffect(() => {
    let frame = 0;
    let refreshingForWorker = false;
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
      const hadController = Boolean(navigator.serviceWorker.controller);
      const refreshForWorker = () => {
        if (hadController && !refreshingForWorker) {
          refreshingForWorker = true;
          window.location.reload();
        }
      };
      navigator.serviceWorker.addEventListener("controllerchange", refreshForWorker);
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then(registration => registration.update())
        .catch(error => {
          console.warn("[terminalz] service worker registration failed", error);
        });

      return () => {
        cancelAnimationFrame(frame);
        window.visualViewport?.removeEventListener("resize", updateViewport);
        window.visualViewport?.removeEventListener("scroll", updateViewport);
        window.removeEventListener("orientationchange", updateViewport);
        window.removeEventListener("resize", updateViewport);
        navigator.serviceWorker.removeEventListener("controllerchange", refreshForWorker);
      };
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
