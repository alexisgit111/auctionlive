import logoWhite from '../assets/brand/logo-white.svg'
import logoColor from '../assets/brand/logo.svg'
import { useImage } from '../lib/imageStore'

/**
 * Official Harcourts Golden Links logo (src/assets/brand).
 * `logo.svg` = navy text for white backgrounds, `logo-white.svg` = reversed for navy backgrounds.
 */
export function BrandLogo({ className = '', variant = 'color' }: { className?: string; variant?: 'color' | 'white'}) {
  return (
    <img
      src={variant === 'white' ? logoWhite : logoColor}
      alt="Harcourts Golden Links"
      className={`${className} w-auto object-contain`}
      draggable={false}
    />
  )
}

/** Compact wordmark for the staff header. */
export function Wordmark() {
  return (
    <div className="flex items-center gap-4">
      <BrandLogo className="h-9" />
      <span className="h-8 w-px bg-line" aria-hidden />
      <span className="text-sm font-bold uppercase tracking-[0.2em] text-brand">Auction Live</span>
    </div>
  )
}

/** Property photo from a stored reference, URL or data URI; placeholder when missing. */
export function PropertyImage({ src, alt = '' }: { src: string | null | undefined; alt?: string }) {
  const url = useImage(src)
  return url ? <img src={url} alt={alt} className="h-full w-full object-cover" /> : <PropertyPlaceholder />
}

/** Auctioneer portrait (cover-cropped), or a neutral silhouette when missing. */
export function AuctioneerPhoto({ src }: { src: string | null | undefined }) {
  const url = useImage(src)
  if (url) return <img src={url} alt="" className="h-full w-full object-cover object-top" />
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full bg-brand-50 text-brand/40" aria-hidden>
      <circle cx="32" cy="24" r="12" fill="currentColor" />
      <path d="M8 64c0-14 11-22 24-22s24 8 24 22z" fill="currentColor" />
    </svg>
  )
}

/** Neutral placeholder when a session has no property photo. */
export function PropertyPlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand-50 via-subtle to-subtle-2">
      <svg viewBox="0 0 120 100" className="w-1/4 opacity-40" fill="none" stroke="#00A1E9" strokeWidth="3" aria-hidden>
        <path d="M10 50 60 12l50 38" />
        <path d="M22 42v46h76V42" />
        <path d="M50 88V62h20v26" />
      </svg>
    </div>
  )
}
