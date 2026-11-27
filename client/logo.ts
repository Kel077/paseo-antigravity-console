/**
 * Original Antigravity Console mark ("Stack"): two offset rounded-diamond blades
 * (an ice-white upper blade with a sky-blue status dot over a frosted glass layer)
 * on a deep midnight squircle.
 */
const TOP_BLADE =
  "M 46.95 41.54 Q 50.00 38.00 54.68 38.00 L 85.05 38.00 Q 105.00 38.00 91.98 53.12 L 77.05 70.46 Q 74.00 74.00 69.32 74.00 L 38.95 74.00 Q 19.00 74.00 32.02 58.88 Z";
const BOTTOM_BLADE =
  "M 52.95 57.54 Q 56.00 54.00 60.68 54.00 L 91.05 54.00 Q 111.00 54.00 97.98 69.12 L 83.05 86.46 Q 80.00 90.00 75.32 90.00 L 44.95 90.00 Q 25.00 90.00 38.02 74.88 Z";

/**
 * Generates an inline SVG with distinct `<defs>` IDs per surface so a hidden (`display: none`)
 * sidebar icon never shadows visible gradient references on Web/Electron.
 */
export function antigravityLogoSvg(scope = "main"): string {
  const s = scope ? `-${scope}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
<defs>
<radialGradient id="ac-bg${s}" cx="50%" cy="16%" r="88%">
<stop offset="0%" stop-color="#272F42"/>
<stop offset="52%" stop-color="#151A26"/>
<stop offset="100%" stop-color="#0D1018"/>
</radialGradient>
<linearGradient id="ac-top${s}" x1="26" y1="38" x2="98" y2="74" gradientUnits="userSpaceOnUse">
<stop offset="0%" stop-color="#F8FAFC"/>
<stop offset="58%" stop-color="#EFF4F9"/>
<stop offset="100%" stop-color="#DFE7F2"/>
</linearGradient>
<linearGradient id="ac-glass${s}" x1="34" y1="54" x2="104" y2="90" gradientUnits="userSpaceOnUse">
<stop offset="0%" stop-color="#E2E8F0" stop-opacity="0.40"/>
<stop offset="55%" stop-color="#94A3B8" stop-opacity="0.28"/>
<stop offset="100%" stop-color="#64748B" stop-opacity="0.24"/>
</linearGradient>
<linearGradient id="ac-glass-rim${s}" x1="30" y1="54" x2="106" y2="90" gradientUnits="userSpaceOnUse">
<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.72"/>
<stop offset="48%" stop-color="#CBD5E1" stop-opacity="0.28"/>
<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.62"/>
</linearGradient>
<linearGradient id="ac-dot${s}" x1="87.5" y1="43" x2="93.5" y2="49" gradientUnits="userSpaceOnUse">
<stop offset="0%" stop-color="#93C5FD"/>
<stop offset="100%" stop-color="#60A5FA"/>
</linearGradient>
</defs>
<rect x="0" y="0" width="128" height="128" rx="28" fill="url(#ac-bg${s})"/>
<rect x="0.5" y="0.5" width="127" height="127" rx="27.5" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="1"/>
<path d="${TOP_BLADE}" fill="url(#ac-top${s})"/>
<circle cx="90.5" cy="46" r="3" fill="url(#ac-dot${s})"/>
<path d="${BOTTOM_BLADE}" fill="url(#ac-glass${s})" stroke="url(#ac-glass-rim${s})" stroke-width="1.25"/>
</svg>`;
}

export const antigravityLogo = antigravityLogoSvg("main");

/** Single-color mark that follows the surface's icon color. */
export const antigravityMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none"><path d="${TOP_BLADE}" fill="currentColor"/><path d="${BOTTOM_BLADE}" fill="currentColor" fill-opacity="0.32" stroke="currentColor" stroke-width="4"/></svg>`;
