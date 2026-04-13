// Cards402 wordmark. Rendered as a CSS mask over the current text color
// so it inherits whatever `color` the parent sets — light on dark surfaces,
// dark on light surfaces, a single accent for emphasis, etc. No inline
// SVG, no children, no theme branching. Just set `color:` on the parent.
//
// Chrome's SVG rendering can blur subpixel edges on hidpi displays. We
// force crisp edges via `image-rendering: crisp-edges` on webkit and the
// mask mode mask-repeat: no-repeat / mask-size: contain combo locks the
// aspect so it doesn't skew during layout.
//
// Two variants:
//   <Wordmark />    — full horizontal lockup (globe + "Cards402")
//   <Wordmark mark /> — just the globemark, useful for tight nav bars
//
// Props:
//   height — vertical size in px (default 28). Width auto-scales.
//   className — forwarded to the span for layout.

import type { CSSProperties } from 'react';

const ASPECT = 522.42 / 120.59; // full lockup aspect ratio from the SVG viewBox
const MARK_ASPECT = 120.59 / 120.59; // square for just the mark crop

interface Props {
  height?: number;
  mark?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Wordmark({
  height = 28,
  mark = false,
  title = 'Cards402',
  className,
  style,
}: Props) {
  const aspect = mark ? MARK_ASPECT : ASPECT;
  const width = Math.round(height * aspect);
  // When rendering the mark-only variant, we crop the left ~23% of the
  // full SVG (the globe sits at x ≈ 0-120 of a 522 viewBox). The
  // mask-size uses the full logo width so the crop snaps the globemark
  // to the visible box without needing a second asset.
  const maskSize = mark ? `${width * (522.42 / 120.59)}px ${height}px` : `contain`;
  const maskPosition = mark ? 'left center' : 'center';

  return (
    <span
      role="img"
      aria-label={title}
      className={className}
      style={{
        display: 'inline-block',
        width,
        height,
        backgroundColor: 'currentColor',
        maskImage: 'url(/logo.svg)',
        maskRepeat: 'no-repeat',
        maskSize,
        maskPosition,
        WebkitMaskImage: 'url(/logo.svg)',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskSize: maskSize,
        WebkitMaskPosition: maskPosition,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
