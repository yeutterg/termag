/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */

/**
 * Performance optimization utilities
 */

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
}

const cache = new Map<string, CacheEntry<any>>();

/**
 * Memoize a function with TTL (time-to-live)
 */
export function memoize<T extends (...args: any[]) => any>(
  fn: T,
  keyGenerator?: (...args: Parameters<T>) => string,
  ttl: number = 5000
): T {
  return ((...args: Parameters<T>) => {
    const key = keyGenerator ? keyGenerator(...args) : JSON.stringify(args);
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && now - cached.timestamp < cached.ttl) {
      return cached.value;
    }

    const result = fn(...args);
    cache.set(key, {
      value: result,
      timestamp: now,
      ttl,
    });

    return result;
  }) as T;
}

/**
 * Clear all memoized cache
 */
export function clearMemoCache(): void {
  cache.clear();
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Request animation frame throttle
 */
export function rafThrottle<T extends (...args: any[]) => any>(
  fn: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null;
  let lastArgs: Parameters<T> | null = null;

  return (...args: Parameters<T>) => {
    lastArgs = args;

    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (lastArgs) {
          fn(...lastArgs);
        }
        rafId = null;
        lastArgs = null;
      });
    }
  };
}

/**
 * Lazy load a component
 */
export function lazyLoad<T extends () => Promise<any>>(
  loader: T
): {
  load: () => Promise<any>;
  Component: React.LazyExoticComponent<any>;
} {
  const Component = React.lazy(loader);

  return {
    load: loader,
    Component,
  };
}

/**
 * Virtual scroll helper for large lists
 */
export function calculateVisibleRange(
  scrollTop: number,
  containerHeight: number,
  itemHeight: number,
  totalItems: number,
  overscan: number = 5
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(containerHeight / itemHeight);
  const end = Math.min(totalItems, start + visibleCount + overscan * 2);

  return { start, end };
}

/**
 * Batch DOM updates
 */
export function batchUpdates(updates: Array<() => void>): void {
  requestAnimationFrame(() => {
    updates.forEach(update => update());
  });
}

/**
 * Measure performance of a function
 */
export async function measurePerformance<T>(
  fn: () => Promise<T>,
  label: string
): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;

  if (typeof window !== "undefined" && "performance" in window) {
    console.log(`[Performance] ${label}: ${duration.toFixed(2)}ms`);
  }

  return { result, duration };
}

/**
 * Create a performance observer
 */
export function createPerformanceObserver(
  callback: (entries: PerformanceEntry[]) => void
): PerformanceObserver | null {
  if (typeof window === "undefined" || !("PerformanceObserver" in window)) {
    return null;
  }

  try {
    const observer = new PerformanceObserver(list => {
      callback(list.getEntries());
    });

    observer.observe({ entryTypes: ["measure", "navigation", "resource"] });

    return observer;
  } catch (error) {
    console.error("Failed to create performance observer:", error);
    return null;
  }
}

/**
 * Mark a performance measurement
 */
export function markPerformance(name: string): void {
  if (typeof window !== "undefined" && "performance" in window) {
    performance.mark(name);
  }
}

/**
 * Measure between two performance marks
 */
export function measurePerformanceBetween(name: string, startMark: string, endMark: string): void {
  if (typeof window !== "undefined" && "performance" in window) {
    try {
      performance.measure(name, startMark, endMark);
    } catch (error) {
      console.error("Failed to measure performance:", error);
    }
  }
}
