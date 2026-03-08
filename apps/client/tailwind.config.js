const tricigoPreset = require('@tricigo/theme/tailwind-preset');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  presets: [tricigoPreset],
  theme: {
    extend: {},
  },
  plugins: [],
};
