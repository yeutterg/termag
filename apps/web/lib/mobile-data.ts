type NetworkInformationLike = {
  saveData?: boolean;
  effectiveType?: string;
};

/**
 * Prefer a lower-bandwidth transport policy on explicitly metered/slow
 * connections and on touch-first phone/tablet layouts. This is intentionally
 * evaluated only in the browser; callers use it when opening a connection,
 * so server rendering remains deterministic.
 */
export function prefersLowDataMode(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  const slowConnection = /^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? "");
  const compactLayout = window.matchMedia("(max-width: 767px)").matches;
  const touchPortable =
    window.matchMedia("(any-pointer: coarse)").matches &&
    window.matchMedia("(max-width: 1024px)").matches;
  return Boolean(connection?.saveData) || slowConnection || compactLayout || touchPortable;
}
