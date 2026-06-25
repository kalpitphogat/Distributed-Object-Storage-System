export const dynamic = 'force-dynamic';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

interface NodeHealth {
  id: string;
  nodeUrl: string;
  status: string;
  capacityBytes: number;
  usedBytes: number;
  virtualNodeCount: number;
  lastHeartbeatAt: string | null;
  replicaCount: number;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${n} B`;
}

function statusColor(status: string): string {
  if (status === 'active') return '#3fb950';
  if (status === 'draining') return '#d29922';
  return '#f85149';
}

async function getNodeHealth(): Promise<NodeHealth[]> {
  try {
    const res = await fetch(`${API_URL}/admin/nodes`, { next: { revalidate: 15 } });
    if (!res.ok) return [];
    return res.json() as Promise<NodeHealth[]>;
  } catch {
    return [];
  }
}

export default async function NodesPage() {
  const nodes = await getNodeHealth();

  return (
    <div>
      <h2 style={{ color: '#58a6ff' }}>Storage Node Health</h2>
      <p style={{ color: '#8b949e' }}>RF=3 ring — {nodes.length} node(s) registered</p>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #30363d', color: '#8b949e' }}>
            <th style={{ textAlign: 'left', padding: '0.5rem 1rem' }}>Node URL</th>
            <th style={{ textAlign: 'left', padding: '0.5rem 1rem' }}>Status</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Capacity</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Used</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Replicas</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Virtual nodes</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id} style={{ borderBottom: '1px solid #21262d' }}>
              <td style={{ padding: '0.5rem 1rem', fontFamily: 'monospace' }}>{n.nodeUrl}</td>
              <td style={{ padding: '0.5rem 1rem' }}>
                <span style={{ color: statusColor(n.status), fontWeight: 600 }}>{n.status}</span>
              </td>
              <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{formatBytes(n.capacityBytes)}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{formatBytes(n.usedBytes)}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{n.replicaCount.toLocaleString()}</td>
              <td style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>{n.virtualNodeCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
