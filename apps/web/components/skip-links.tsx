"use client";

import { useEffect, useRef } from "react";

interface SkipLinkProps {
  targetId: string;
  label: string;
  className?: string;
}

export function SkipLink({ targetId, label, className }: SkipLinkProps) {
  const linkRef = useRef<HTMLAnchorElement>(null);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const target = document.getElementById(targetId);
    if (target) {
      target.focus();
      target.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <a
      ref={linkRef}
      href={`#${targetId}`}
      onClick={handleClick}
      className={cn(
        "sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4",
        "z-50 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium",
        "transition-all duration-200 hover:bg-blue-700",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
        className
      )}
    >
      {label}
    </a>
  );
}

export function SkipLinks() {
  return (
    <>
      <SkipLink targetId="main-content" label="Skip to main content" />
      <SkipLink targetId="navigation" label="Skip to navigation" />
    </>
  );
}

export function FocusTrap({
  children,
  isActive,
}: {
  children: React.ReactNode;
  isActive: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ) as NodeListOf<HTMLElement>;

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") {
        return;
      }

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          lastFocusable.focus();
          e.preventDefault();
        }
      } else {
        if (
          document.activeElement === lastFocusable ||
          !container.contains(document.activeElement)
        ) {
          firstFocusable.focus();
          e.preventDefault();
        }
      }
    };

    container.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("keydown", handleKeyDown);
    };
  }, [isActive]);

  return <div ref={containerRef}>{children}</div>;
}
