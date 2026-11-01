/**
 * Tokyo Night Storm, the palette of the native clients
 * (`legacy/ios/CmuxRemote/UI/CmuxTheme.swift`).
 */
export const colors = {
  canvas: '#1a1b26',
  surface: '#24283b',
  surfaceRaised: '#292e42',
  surfaceSunken: '#1f2335',
  terminal: '#16161e',
  ink: '#c0caf5',
  inkDim: '#a9b1d6',
  muted: '#565f89',
  mutedDim: '#414868',
  divider: '#3b4261',
  border: '#545c7e',
  blue: '#7aa2f7',
  cyan: '#7dcfff',
  green: '#9ece6a',
  yellow: '#e0af68',
  orange: '#ff9e64',
  red: '#f7768e',
  magenta: '#bb9af7',
  terminalText: '#f1f2f8',
} as const;

export const fonts = {
  mono: 'GeistMono-Regular',
  monoBold: 'GeistMono-Bold',
} as const;

/** Advance width of one GeistMono cell, as a fraction of the font size. */
export const MONO_ADVANCE_EM = 0.6;
