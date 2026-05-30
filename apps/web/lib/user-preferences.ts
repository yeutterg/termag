export interface UserPreferences {
  // Terminal settings
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  letterSpacing: number;

  // Theme settings
  colorTheme: "dark" | "light" | "custom";
  customTheme?: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  };

  // Session settings
  autoSaveEnabled: boolean;
  autoSaveInterval: number; // seconds
  maxSnapshots: number;

  // UI settings
  showLineNumbers: boolean;
  showScrollbackLimit: number;
  animateTransitions: boolean;
  enableSoundEffects: boolean;
}

const PREFERENCES_KEY = "termag-user-preferences";

const DEFAULT_PREFERENCES: UserPreferences = {
  fontSize: 14,
  fontFamily: '"Fira Code", "JetBrains Mono", monospace',
  lineHeight: 1.5,
  letterSpacing: 0,
  colorTheme: "dark",
  autoSaveEnabled: true,
  autoSaveInterval: 30,
  maxSnapshots: 10,
  showLineNumbers: false,
  showScrollbackLimit: 10000,
  animateTransitions: true,
  enableSoundEffects: false,
};

/**
 * Get user preferences from localStorage
 */
export function getUserPreferences(): UserPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return stored ? { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) } : DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Failed to load preferences:", error);
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Save user preferences to localStorage
 */
export function saveUserPreferences(preferences: UserPreferences): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error("Failed to save preferences:", error);
  }
}

/**
 * Update a specific preference
 */
export function updatePreference<K extends keyof UserPreferences>(
  key: K,
  value: UserPreferences[K]
): void {
  const preferences = getUserPreferences();
  preferences[key] = value;
  saveUserPreferences(preferences);
}

/**
 * Reset preferences to defaults
 */
export function resetPreferences(): void {
  saveUserPreferences(DEFAULT_PREFERENCES);
}

/**
 * Apply terminal settings to xterm.js instance
 */
export function applyTerminalSettings(term: any, preferences: UserPreferences): void {
  if (!term) {
    return;
  }

  term.options.fontSize = preferences.fontSize;
  term.options.fontFamily = preferences.fontFamily;
  term.options.lineHeight = preferences.lineHeight;
  term.options.letterSpacing = preferences.letterSpacing;

  // Apply custom theme if set
  if (preferences.customTheme) {
    term.options.theme = preferences.customTheme;
  }
}
