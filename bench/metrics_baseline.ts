import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve(__dirname, 'hmic_bench.db');

async function setup() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

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
  `);

  return db;
}

async function runBenchmark() {
  const db = await setup();
  console.log('Inserting 100,000 records...');

  const start = Date.now();

  await db.run('BEGIN TRANSACTION');
  for (let i = 0; i < 100000; i++) {
    // Simulate past data (some older than 1 day)
    // 17280 records per day (every 5s)
    // So 100k records cover ~5.7 days.
    // Let's create timestamps going back 6 days.
    const timeOffset = (100000 - i) * 5000; // ms ago
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

  // Measure query performance (SELECT last 100)
  const queryStart = Date.now();
  await db.all('SELECT * FROM metrics ORDER BY timestamp DESC LIMIT 100');
  const queryTime = Date.now() - queryStart;
  console.log(`Query (last 100) took: ${queryTime}ms`);

  // Simulate Cleanup (The Optimization)
  console.log('Running cleanup (keeping last 24h)...');
  const cleanupStart = Date.now();
  // Keep last 24 hours
  // DELETE FROM metrics WHERE timestamp < datetime('now', '-1 day')
  await db.run("DELETE FROM metrics WHERE timestamp < datetime('now', '-1 day')");
  // VACUUM to reclaim space
  await db.run("VACUUM");
  const cleanupTime = Date.now() - cleanupStart;

  const finalSize = fs.statSync(DB_PATH).size / (1024 * 1024);
  console.log(`Final DB Size: ${finalSize.toFixed(2)} MB`);
  console.log(`Cleanup took: ${cleanupTime}ms`);

  const finalQueryStart = Date.now();
  await db.all('SELECT * FROM metrics ORDER BY timestamp DESC LIMIT 100');
  const finalQueryTime = Date.now() - finalQueryStart;
  console.log(`Final Query (last 100) took: ${finalQueryTime}ms`);
}

runBenchmark().catch(console.error);
