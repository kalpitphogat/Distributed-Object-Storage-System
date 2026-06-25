export const dynamic = 'force-dynamic';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

interface GcStats {
  totalChunks: number;
  orphanedChunks: number;
  totalBytes: number;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  return `${n} B`;
}

async function getGcStats(): Promise<GcStats | null> {
  try {
    const res = await fetch(`${API_URL}/admin/gc/stats`, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    return res.json() as Promise<GcStats>;
  } catch {
    return null;
  }
}

export default async function GcPage() {
  const stats = await getGcStats();

  return (
    <div>
      <h2 style={{ color: '#58a6ff' }}>Garbage Collection</h2>
      <p style={{ color: '#8b949e', fontSize: '0.9rem' }}>
        Mark-and-sweep GC runs hourly via BullMQ. Chunks with ref_count=0 older than the grace
        period are deleted from all replicas and removed from the DB.
      </p>
      {stats ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginTop: '1.5rem' }}>
          <StatCard label="Total chunks" value={stats.totalChunks.toLocaleString()} />
          <StatCard label="Orphaned (ref=0)" value={stats.orphanedChunks.toLocaleString()} color={stats.orphanedChunks > 0 ? '#d29922' : '#3fb950'} />
          <StatCard label="Total chunk storage" value={formatBytes(stats.totalBytes)} />
        </div>
      ) : (
        <p style={{ color: '#f85149' }}>Could not load GC stats.</p>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '1.5rem' }}>
      <div style={{ color: '#8b949e', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{label}</div>
      <div style={{ fontSize: '1.8rem', fontWeight: 700, color: color ?? '#e6edf3' }}>{value}</div>
    </div>
  );
}
