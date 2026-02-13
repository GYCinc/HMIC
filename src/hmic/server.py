import os
import sqlite3
import datetime
import json
from mcp.server.fastmcp import FastMCP

# Configuration
VOLUME_PATH = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "/app/data")
DB_PATH = os.path.join(VOLUME_PATH, "hmic.db")
VECTOR_DB_PATH = os.path.join(VOLUME_PATH, "lancedb")

# Initialize Server
mcp = FastMCP("hmic-core")

# Database Setup
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS students (
            id TEXT PRIMARY KEY,
            name TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS accomplishments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT,
            topic TEXT,
            concept_id TEXT,
            owned BOOLEAN DEFAULT FALSE,
            status TEXT DEFAULT 'Workin on it',
            next_review_date DATETIME,
            ease_factor REAL DEFAULT 2.5,
            last_review_date DATETIME
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sightings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT,
            concept_id TEXT,
            transcript_text TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

# Ensure DB exists
if not os.path.exists(VOLUME_PATH):
    os.makedirs(VOLUME_PATH)
init_db()

# --- RESOURCES ---

@mcp.resource("mcp://{student_id}/mastery_map")
def get_mastery_map(student_id: str) -> str:
    """Returns JSON object of the student's current BKT state."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT topic, concept_id, status, owned
        FROM accomplishments
        WHERE student_id = ? AND (owned = 1 OR status = 'Workin on it')
    """, (student_id,))
    rows = cursor.fetchall()
    conn.close()

    result = [
        {"topic": r[0], "concept_id": r[1], "status": r[2], "owned": bool(r[3])}
        for r in rows
    ]
    return json.dumps(result)

@mcp.resource("mcp://{student_id}/ghost_map")
def get_ghost_map(student_id: str) -> str:
    """Returns Heatmap of the 'Lexical Spread' (items sighted but not owned)."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    # Find concepts in sightings that are NOT owned in accomplishments
    cursor.execute("""
        SELECT s.concept_id, COUNT(s.id) as sighting_count
        FROM sightings s
        LEFT JOIN accomplishments a ON s.concept_id = a.concept_id AND s.student_id = a.student_id
        WHERE s.student_id = ? AND (a.owned = 0 OR a.owned IS NULL)
        GROUP BY s.concept_id
    """, (student_id,))
    rows = cursor.fetchall()
    conn.close()

    result = [{"concept_id": r[0], "sighting_count": r[1]} for r in rows]
    return json.dumps(result)

@mcp.resource("mcp://{student_id}/recycling_queue")
def get_recycling_queue(student_id: str) -> str:
    """Returns Items due for review today."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    now = datetime.datetime.now().isoformat()
    cursor.execute("""
        SELECT * FROM accomplishments
        WHERE student_id = ? AND next_review_date < ?
    """, (student_id, now))
    rows = cursor.fetchall()
    conn.close()

    # Simple list of dicts
    columns = [desc[0] for desc in cursor.description]
    result = [dict(zip(columns, row)) for row in rows]
    return json.dumps(result)

# --- TOOLS ---

@mcp.tool()
def ingest_session(transcript: str, student_id: str) -> str:
    """
    Runs NLP analysis (spaCy), identifies items, calculates BKT updates,
    and writes to SQLite.
    """
    # Placeholder for spaCy / BKT Logic
    # In a real implementation, we would load the model here or globally.
    # import spacy
    # nlp = spacy.load("en_core_web_lg")
    # doc = nlp(transcript)

    # Mocking extraction of 600 items for performance demo
    extracted_items = ["concept_a", "concept_b", "concept_c"]

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    for item in extracted_items:
        # Record Sighting
        cursor.execute("""
            INSERT INTO sightings (student_id, concept_id, transcript_text)
            VALUES (?, ?, ?)
        """, (student_id, item, transcript[:50] + "..."))

        # Update/Create Accomplishment (Mock BKT)
        cursor.execute("""
            INSERT INTO accomplishments (student_id, topic, concept_id, status, last_review_date)
            VALUES (?, 'General', ?, 'Workin on it', CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET last_review_date = CURRENT_TIMESTAMP
        """, (student_id, item))

    conn.commit()
    conn.close()

    return f"Ingested {len(extracted_items)} items for student {student_id}."

@mcp.tool()
def query_concordance(topic: str, concept_id: str, student_id: str) -> str:
    """
    Searches the student's history for their own usage of a concept.
    Uses Vector Search on sightings table.
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Mock Vector Search using LIKE for now (actual requires lancedb setup)
    cursor.execute("""
        SELECT transcript_text, timestamp FROM sightings
        WHERE student_id = ? AND concept_id = ?
        ORDER BY timestamp DESC LIMIT 5
    """, (student_id, concept_id))

    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return f"No usage found for {concept_id}."

    response = f"Found {len(rows)} usages of '{concept_id}':\n"
    for row in rows:
        response += f"- [{row[1]}] ...{row[0]}...\n"

    return response

@mcp.tool()
def resurrect_item(phenomenon_id: str, student_id: str) -> str:
    """
    Moves an item from 'Ghost/Graduated' back to 'Active'.
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        UPDATE accomplishments
        SET owned = 1, status = 'Resurrected', ease_factor = 1.3, next_review_date = CURRENT_TIMESTAMP
        WHERE student_id = ? AND concept_id = ?
    """, (student_id, phenomenon_id))

    if cursor.rowcount == 0:
        conn.close()
        return f"Item {phenomenon_id} not found for student {student_id}."

    conn.commit()
    conn.close()
    return f"Resurrected item {phenomenon_id}."

if __name__ == "__main__":
    mcp.run()
