export const dynamic = 'force-dynamic';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

interface BucketStats {
  bucketId: string;
  name: string;
  totalObjects: number;
  totalBytes: number;
  bandwidthBytes30d: number;
  updatedAt: string;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

async function getBucketStats(): Promise<BucketStats[]> {
  try {
    const res = await fetch(`${API_URL}/admin/buckets`, { next: { revalidate: 30 } });
    if (!res.ok) return [];
    return res.json() as Promise<BucketStats[]>;
  } catch {
    return [];
  }
}

export default async function DashboardPage() {
  const stats = await getBucketStats();

  return (
    <div>
      <h2 style={{ color: '#58a6ff' }}>Bucket Analytics</h2>
      {stats.length === 0 ? (
        <p style={{ color: '#8b949e' }}>No buckets yet.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #30363d', color: '#8b949e' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem 1rem' }}>Bucket</th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Objects</th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Storage</th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Bandwidth (30d)</th>
              <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.bucketId} style={{ borderBottom: '1px solid #21262d' }}>
                <td style={{ padding: '0.5rem 1rem', color: '#58a6ff' }}>{s.name}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{s.totalObjects.toLocaleString()}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{formatBytes(s.totalBytes)}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{formatBytes(s.bandwidthBytes30d)}</td>
                <td style={{ textAlign: 'right', padding: '0.5rem 1rem', color: '#8b949e', fontSize: '0.85rem' }}>
                  {new Date(s.updatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
