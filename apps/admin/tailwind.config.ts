import type { Config } from 'tailwindcss';

const tricigoPreset = require('@tricigo/theme/tailwind-preset');

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
  ],
  presets: [tricigoPreset],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
