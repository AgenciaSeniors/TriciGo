import { ImageResponse } from 'next/og';
import { readFileSync } from 'fs';
import { join } from 'path';

// Dynamic Open Graph / Twitter share card. Renders the real TriciGo wordmark
// logo on a polished dark composition. Design direction (ui-ux-pro-max):
// "energetic orange + green on deep navy" mobility palette + Aurora-style warm
// radial glow — Cuban warmth (sunset light) without literal clichés. Generated
// in code with next/og so it stays in sync with the brand asset (no editor).
export const runtime = 'nodejs';
export const alt = 'TriciGo — Muévete por Cuba';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const NAVY_BG = 'linear-gradient(135deg, #0a0e1a 0%, #0f172a 55%, #131c30 100%)';
const WARM_GLOW = 'radial-gradient(circle, rgba(249,115,22,0.32) 0%, rgba(234,88,12,0.12) 38%, rgba(15,23,42,0) 66%)';
const GREEN_GLOW = 'radial-gradient(circle, rgba(5,150,105,0.16) 0%, rgba(5,150,105,0) 64%)';
const ACCENT_BAR = 'linear-gradient(90deg, rgba(249,115,22,0) 0%, #f97316 50%, rgba(249,115,22,0) 100%)';
const TOP_EDGE = 'linear-gradient(90deg, #ea580c 0%, #f97316 45%, rgba(249,115,22,0) 100%)';

export default async function OpengraphImage() {
  const logo = readFileSync(join(process.cwd(), 'public', 'logo-wordmark-white.png'));
  const logoSrc = `data:image/png;base64,${logo.toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: NAVY_BG,
          overflow: 'hidden',
        }}
      >
        {/* Warm sunset glow behind the wordmark (center, upper third). */}
        <div style={{ position: 'absolute', top: -260, left: 100, width: 1000, height: 1000, background: WARM_GLOW }} />
        {/* Faint green depth glow (bottom-left) — the palette's accent. */}
        <div style={{ position: 'absolute', top: 340, left: -220, width: 760, height: 760, background: GREEN_GLOW }} />
        {/* Branded top edge. */}
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 8, background: TOP_EDGE }} />

        {/* Content */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 30,
            padding: 40,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={560} height={133} alt="TriciGo" />
          <div style={{ display: 'flex', fontSize: 54, fontWeight: 800, color: '#f8fafc', letterSpacing: -0.5 }}>
            Muévete por Cuba
          </div>
          {/* Brand accent underline (also reads as a movement/road cue). */}
          <div style={{ width: 168, height: 5, borderRadius: 999, background: ACCENT_BAR }} />
          <div style={{ display: 'flex', fontSize: 29, fontWeight: 500, color: '#94a3b8', letterSpacing: 2 }}>
            Triciclos · Motos · Autos
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
