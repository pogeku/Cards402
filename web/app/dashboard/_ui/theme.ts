// Theme helper — reads stored preference + system default, applies to <html>.
// Runs at mount time; there may be a flash on first paint since we're not
// using SSR cookies for this (acceptable trade-off for PoC).

export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'cards402.theme';

export function loadTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  return 'dark';
}

export function saveTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function applyTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  const effective =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.setAttribute('data-theme', effective);
}
