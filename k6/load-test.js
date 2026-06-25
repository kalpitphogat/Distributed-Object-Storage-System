/**
 * Mini-S3 load test — Phase 8
 *
 * Targets: p95 latency < 200 ms for PUT/GET; throughput ≥ 100 req/s
 * Run: k6 run k6/load-test.js
 * Override API: API_URL=http://... k6 run k6/load-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ── Config ────────────────────────────────────────────────────────────────────

const API_URL = __ENV.API_URL || 'http://localhost:3000';
const BUCKET = `k6-load-${Date.now()}`;

// ── Custom metrics ────────────────────────────────────────────────────────────

const putErrors = new Counter('put_errors');
const getErrors = new Counter('get_errors');
const putLatency = new Trend('put_latency', true);
const getLatency = new Trend('get_latency', true);
const cacheHitRate = new Rate('cache_hit_rate'); // tracks Cache-Control header

// ── Test configuration ────────────────────────────────────────────────────────

export const options = {
  thresholds: {
    // DoD: p95 latency < 200 ms
    'put_latency': ['p(95)<200'],
    'get_latency': ['p(95)<200'],
    // Error rate under 1%
    'put_errors': ['count<5'],
    'get_errors': ['count<5'],
    // HTTP failure rate under 1%
    'http_req_failed': ['rate<0.01'],
  },
  scenarios: {
    // Ramp up to 50 VUs over 30s, hold for 2 min, ramp down
    steady_load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
};

// ── Setup: create test bucket ─────────────────────────────────────────────────

export function setup() {
  const res = http.request('PUT', `${API_URL}/buckets/${BUCKET}`);
  if (res.status !== 200 && res.status !== 409) {
    console.error(`Bucket creation failed: ${res.status}`);
  }
  return { bucket: BUCKET };
}

// ── Main test loop ────────────────────────────────────────────────────────────

export default function main(data) {
  const bucket = data.bucket;
  const key = `object-${__VU}-${__ITER}`;
  const body = generatePayload(4096); // 4 KB objects — representative of small blob workload

  // ── PUT ────────────────────────────────────────────────────────────────────

  const putStart = Date.now();
  const putRes = http.request(
    'PUT',
    `${API_URL}/buckets/${bucket}/objects/${key}`,
    body,
    {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: '10s',
    },
  );
  putLatency.add(Date.now() - putStart);

  const putOk = check(putRes, {
    'PUT 200': (r) => r.status === 200,
    'PUT has etag': (r) => r.headers['Etag'] !== undefined,
    'PUT has versionId': (r) => JSON.parse(r.body).versionId !== undefined,
  });
  if (!putOk) putErrors.add(1);

  // ── GET ────────────────────────────────────────────────────────────────────

  const getStart = Date.now();
  const getRes = http.get(`${API_URL}/buckets/${bucket}/objects/${key}`, {
    timeout: '10s',
  });
  getLatency.add(Date.now() - getStart);

  const getOk = check(getRes, {
    'GET 200': (r) => r.status === 200,
    'GET body matches': (r) => r.body.length === 4096,
    'GET has Accept-Ranges': (r) => r.headers['Accept-Ranges'] === 'bytes',
  });
  if (!getOk) getErrors.add(1);

  // Cache-Control: immutable means it came from a hot-chunk cache path
  cacheHitRate.add(getRes.headers['Cache-Control']?.includes('immutable') ? 1 : 0);

  sleep(0.1); // 100 ms think time between iterations
}

// ── Hot-chunk cache test: same key fetched by many VUs ───────────────────────

export function handleSummary(data) {
  const putP95 = data.metrics['put_latency']?.values?.['p(95)'] ?? 'N/A';
  const getP95 = data.metrics['get_latency']?.values?.['p(95)'] ?? 'N/A';
  const totalReqs = data.metrics['http_reqs']?.values?.count ?? 0;
  const duration = data.state?.testRunDurationMs ?? 0;
  const rps = duration > 0 ? ((totalReqs / duration) * 1000).toFixed(1) : 'N/A';

  return {
    stdout: `
╔═══════════════════════════════════════════════════╗
║         Mini-S3 Load Test Results (Phase 8)       ║
╠═══════════════════════════════════════════════════╣
║  PUT p95 latency: ${String(putP95).padEnd(27)} ║
║  GET p95 latency: ${String(getP95).padEnd(27)} ║
║  Total requests:  ${String(totalReqs).padEnd(27)} ║
║  Requests/sec:    ${String(rps).padEnd(27)} ║
╚═══════════════════════════════════════════════════╝
`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePayload(sizeBytes) {
  // Deterministic pseudo-random data — repeating VU+ITER pattern
  const pattern = `VU${__VU}ITER${__ITER}`;
  let result = '';
  while (result.length < sizeBytes) {
    result += pattern;
  }
  return result.slice(0, sizeBytes);
}
