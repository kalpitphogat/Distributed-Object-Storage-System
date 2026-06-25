export const metadata = { title: 'Mini-S3 Admin', description: 'Distributed Object Storage Admin Console' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: '-apple-system, monospace', background: '#0d1117', color: '#e6edf3' }}>
        <nav style={{ background: '#161b22', borderBottom: '1px solid #30363d', padding: '1rem 2rem', display: 'flex', gap: '2rem', alignItems: 'center' }}>
          <strong style={{ color: '#58a6ff', fontSize: '1.1rem' }}>Mini-S3 Admin</strong>
          <a href="/" style={{ color: '#8b949e', textDecoration: 'none' }}>Dashboard</a>
          <a href="/nodes" style={{ color: '#8b949e', textDecoration: 'none' }}>Nodes</a>
          <a href="/gc" style={{ color: '#8b949e', textDecoration: 'none' }}>GC</a>
        </nav>
        <main style={{ padding: '2rem' }}>{children}</main>
      </body>
    </html>
  );
}
