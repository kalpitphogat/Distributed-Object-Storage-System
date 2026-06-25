#!/bin/sh
# Runs all SQL migration files in order against Postgres.
# node-pg-migrate is used from the root workspace.

set -e

echo "Waiting for Postgres to be ready..."
# pg_isready is not available in node:alpine, so we poll with psql via env var
until node -e "
const { Client } = require('/usr/local/lib/node_modules/pg/lib');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).catch(e => { process.exit(1); });
" 2>/dev/null; do
  echo "  still waiting..."
  sleep 2
done

echo "Running migrations..."
for f in /app/migrations/*.sql; do
  echo "  applying $f"
  # Use psql via node-postgres to run each file
  node -e "
const fs = require('fs');
const { Client } = require('/usr/local/lib/node_modules/pg/lib');
const sql = fs.readFileSync('$f', 'utf8');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query(sql))
  .then(() => c.end())
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
"
done

echo "Migrations complete."
