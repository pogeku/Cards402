// Consistent padding + max-width + stacking rhythm for every dashboard
// page. Pages compose their content inside this so gutters, gaps, and
// max-width all come from one place.

import type { CSSProperties, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  maxWidth?: number;
  gap?: string | number;
}

export function PageContainer({ children, maxWidth = 1400, gap = '1.25rem' }: Props) {
  const style: CSSProperties = {
    padding: '1.5rem 1.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: typeof gap === 'number' ? `${gap}px` : gap,
    maxWidth,
  };
  return (
    <div className="dashboard-page-container" style={style}>
      {children}
    </div>
  );
}
