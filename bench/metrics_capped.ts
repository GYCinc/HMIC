import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve(__dirname, 'hmic_capped.db');
const MAX_ROWS = 5000;

async function setup() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  // Enable WAL mode for performance
  await db.exec('PRAGMA journal_mode = WAL;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      cpu REAL,
      memory REAL,
      active_tools INTEGER,
      total_requests INTEGER,
      error_rate REAL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);

    -- Trigger to cap the table size
    CREATE TRIGGER IF NOT EXISTS limit_metrics_size
    AFTER INSERT ON metrics
    BEGIN
      DELETE FROM metrics WHERE id <= NEW.id - ${MAX_ROWS};
    END;
  `);

  return db;
}

async function runBenchmark() {
  const db = await setup();
  console.log(`Inserting 100,000 records with Trigger (Max ${MAX_ROWS})...`);

  const start = Date.now();

  await db.run('BEGIN TRANSACTION');
  for (let i = 0; i < 100000; i++) {
    const timeOffset = (100000 - i) * 5000;
    const timestamp = new Date(Date.now() - timeOffset).toISOString().replace('T', ' ').slice(0, 19);

    await db.run(
      `INSERT INTO metrics (timestamp, cpu, memory, active_tools, total_requests, error_rate) VALUES (?, ?, ?, ?, ?, ?)`,
      timestamp, 10.5, 512.0, 5, 100 + i, 0.1
    );
  }
  await db.run('COMMIT');

  const duration = Date.now() - start;
  console.log(`Insertion took ${duration}ms`);

  const size = fs.statSync(DB_PATH).size / (1024 * 1024);
  console.log(`DB Size: ${size.toFixed(2)} MB`);

  // Verify count
  const rowCount = await db.get('SELECT COUNT(*) as count FROM metrics');
  console.log(`Row Count: ${rowCount.count}`);

  const queryStart = Date.now();
  await db.all('SELECT * FROM metrics ORDER BY timestamp DESC LIMIT 100');
  const queryTime = Date.now() - queryStart;
  console.log(`Query (last 100) took: ${queryTime}ms`);
}

runBenchmark().catch(console.error);
