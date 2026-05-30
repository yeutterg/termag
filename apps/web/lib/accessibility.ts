/**
 * Accessibility utilities and utilities for WCAG compliance
 */

/**
 * Generate a unique ID for accessibility purposes
 */
export function generateA11yId(prefix: string = "a11y"): string {
  return `${prefix}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Announce a message to screen readers
 */
export function announceToScreenReader(
  message: string,
  priority: "polite" | "assertive" = "polite"
): void {
  if (typeof document === "undefined") {
    return;
  }

  const announcement = document.createElement("div");
  announcement.setAttribute("role", "status");
  announcement.setAttribute("aria-live", priority);
  announcement.setAttribute("aria-atomic", "true");
  announcement.className = "sr-only";
  announcement.textContent = message;

  document.body.appendChild(announcement);

  setTimeout(() => {
    document.body.removeChild(announcement);
  }, 1000);
}

/**
 * Trap focus within an element
 */
export function trapFocus(element: HTMLElement): () => void {
  const focusableElements = element.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  ) as NodeListOf<HTMLElement>;

  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

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
      if (document.activeElement === lastFocusable) {
        firstFocusable.focus();
        e.preventDefault();
      }
    }
  };

  element.addEventListener("keydown", handleKeyDown);
  firstFocusable?.focus();

  return () => {
    element.removeEventListener("keydown", handleKeyDown);
  };
}

/**
 * Check if an element is in the viewport
 */
export function isInViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

/**
 * Scroll an element into view with focus management
 */
export function scrollIntoViewWithFocus(element: HTMLElement): void {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.focus();
}

/**
 * Get all focusable elements in a container
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const focusable = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  ) as NodeListOf<HTMLElement>;
  return Array.from(focusable);
}

/**
 * Manage focus for modal dialogs
 */
export function manageModalFocus(modal: HTMLElement, isOpen: boolean): () => void {
  if (!isOpen) {
    return () => {};
  }

  const previouslyFocused = document.activeElement as HTMLElement;
  const focusableElements = getFocusableElements(modal);
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
      if (document.activeElement === lastFocusable || !modal.contains(document.activeElement)) {
        firstFocusable.focus();
        e.preventDefault();
      }
    }
  };

  modal.addEventListener("keydown", handleKeyDown);

  return () => {
    modal.removeEventListener("keydown", handleKeyDown);
    previouslyFocused?.focus();
  };
}

/**
 * Add keyboard navigation support
 */
export function addKeyboardNavigation(
  container: HTMLElement,
  options: {
    onEnter?: (element: HTMLElement) => void;
    onEscape?: () => void;
    onArrowUp?: (element: HTMLElement) => void;
    onArrowDown?: (element: HTMLElement) => void;
    onArrowLeft?: (element: HTMLElement) => void;
    onArrowRight?: (element: HTMLElement) => void;
  }
): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;

    switch (e.key) {
      case "Enter":
        if (options.onEnter) {
          options.onEnter(target);
        }
        break;
      case "Escape":
        if (options.onEscape) {
          options.onEscape();
        }
        break;
      case "ArrowUp":
        if (options.onArrowUp) {
          options.onArrowUp(target);
          e.preventDefault();
        }
        break;
      case "ArrowDown":
        if (options.onArrowDown) {
          options.onArrowDown(target);
          e.preventDefault();
        }
        break;
      case "ArrowLeft":
        if (options.onArrowLeft) {
          options.onArrowLeft(target);
          e.preventDefault();
        }
        break;
      case "ArrowRight":
        if (options.onArrowRight) {
          options.onArrowRight(target);
          e.preventDefault();
        }
        break;
    }
  };

  container.addEventListener("keydown", handleKeyDown);

  return () => {
    container.removeEventListener("keydown", handleKeyDown);
  };
}
