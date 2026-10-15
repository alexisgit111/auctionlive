/** Simple line icons for property features on the room display (stroke = currentColor). */
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const BedIcon = () => (
  <svg viewBox="0 0 48 32" {...base} aria-hidden>
    <path d="M3 6v22M3 22h42v6M45 22v-6a5 5 0 0 0-5-5H21v11" fill="currentColor" fillOpacity="0.9" />
    <rect x="7" y="12" width="10" height="6" rx="2.5" fill="currentColor" />
  </svg>
)

export const BathIcon = () => (
  <svg viewBox="0 0 48 40" {...base} aria-hidden>
    <path d="M10 18V7a4 4 0 0 1 8 0" />
    <path d="M3 18h42v4c0 7-5 11-12 11H15C8 33 3 29 3 22z" fill="currentColor" />
    <path d="M12 33l-2 5M36 33l2 5" />
  </svg>
)

export const GarageIcon = () => (
  <svg viewBox="0 0 48 44" {...base} aria-hidden>
    <path d="M4 42V17L24 4l20 13v25" strokeWidth="3.4" />
    <path d="M13 32l2-6h18l2 6" />
    <rect x="11" y="31" width="26" height="7" rx="2" fill="currentColor" />
    <path d="M14 38v4M34 38v4" strokeWidth="3" />
  </svg>
)

export const LandIcon = () => (
  <svg viewBox="0 0 44 44" {...base} aria-hidden>
    <rect x="4" y="4" width="36" height="36" strokeDasharray="4 3" />
    <path d="M10 10l24 24M34 10L10 34" />
    <path d="M10 17v-7h7M34 27v7h-7M27 10h7v7M17 34h-7v-7" />
  </svg>
)

export const FloorIcon = () => (
  <svg viewBox="0 0 44 44" {...base} aria-hidden>
    <path d="M4 40V18L22 5l18 13v22z" />
    <path d="M12 40V26h20v14" />
  </svg>
)
