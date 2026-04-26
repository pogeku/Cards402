import Link from 'next/link';

// Static export (GitHub Pages) cannot pre-render runtime dynamic agent IDs.
// Returning no params keeps the build green and excludes this route.
export function generateStaticParams() {
  return [];
}

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div style={{ padding: '2rem', display: 'grid', gap: '0.75rem' }}>
      <h1 style={{ margin: 0, fontSize: '1.25rem' }}>
        Agent detail is unavailable on static hosting
      </h1>
      <p style={{ margin: 0, color: 'var(--fg-dim)' }}>
        Agent ID <code>{id}</code> requires live backend data and cannot be pre-generated for GitHub
        Pages.
      </p>
      <p style={{ margin: 0 }}>
        <Link href="/dashboard/agents">Back to agents</Link>
      </p>
    </div>
  );
}
