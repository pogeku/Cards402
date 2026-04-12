import { Suspense } from 'react';
import { AdminClient } from './client';

// Admin is a client component that calls useSearchParams(), which forces
// a Suspense boundary in Next 16 production builds. Wrap it here in a
// server component so the route still renders during SSG.

export const dynamic = 'force-dynamic';

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <AdminClient />
    </Suspense>
  );
}
