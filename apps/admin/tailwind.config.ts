import type { Config } from 'tailwindcss';
import tricigoPreset from '@tricigo/theme/tailwind-preset';

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
