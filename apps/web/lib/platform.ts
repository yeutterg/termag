export type Platform = {
  /** Show ⌘/⌥/⇧ glyphs (true) vs Ctrl+/Alt+/Shift+ labels (false). */
  isMac: boolean;
  /** False on phones — they have no hardware keyboard, so shortcut hints are clutter. */
  showShortcuts: boolean;
};

/**
 * Best-effort UA-only platform detection. Tablets (iPad, Android tablets) keep
 * shortcut hints because they're commonly used with external keyboards. Phones
 * (iPhone, Android Mobile) drop them entirely. iPadOS in desktop mode reports
 * as Macintosh — which is fine: same Mac glyphs, same showShortcuts.
 */
export function detectPlatformFromUserAgent(ua: string | null | undefined): Platform {
  const userAgent = ua ?? "";
  const isIPhone = /iPhone|iPod/.test(userAgent);
  const isAndroidMobile = /Android/.test(userAgent) && /Mobile/.test(userAgent);
  const isMobile = isIPhone || isAndroidMobile;
  const isMac = /Mac|iPhone|iPad|iPod/.test(userAgent);
  return { isMac, showShortcuts: !isMobile };
}
