// ============================================================
// TriciGo — Brand Constants
// Visual identity based on the Re-branding V1.0 document
// ============================================================

export const brand = {
  name: 'TriciGo',
  tagline: 'Tu plataforma de movilidad',

  // Primary color assignments per brand element
  logo: {
    triciColor: '#111111',  // "Trici" part of the wordmark
    goColor: '#FF4D00',     // "Go" part of the wordmark
  },

  // App icon: white "o" symbol on Go Orange background
  appIcon: {
    backgroundColor: '#FF4D00',
    symbolColor: '#FFFFFF',
  },

  // Social / marketing
  socialBackground: '#111111',
  socialAccent: '#FF4D00',

  // Do's and Don'ts (from brand doc)
  guidelines: {
    allowedBackgrounds: ['#FFFFFF', '#111111', '#FF4D00'],
    forbiddenColors: ['blue', 'green', 'yellow'],
    logoStyle: 'italic-wordmark',
    neverUse: ['old tricycle drawing', 'non-italic logo', 'off-palette colors'],
  },

  // URLs / external
  supportEmail: 'soporte@tricigo.com',
  websiteUrl: 'https://tricigo.com',
} as const;
