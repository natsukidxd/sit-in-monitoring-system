const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'data', 'sitin.sqlite');
const db = new sqlite3.Database(dbPath);

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_number TEXT UNIQUE NOT NULL,
        last_name TEXT NOT NULL,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        course_level TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        course TEXT NOT NULL,
        address TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sitin_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        lab_room TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Active',
        time_in DATETIME DEFAULT CURRENT_TIMESTAMP,
        time_out DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        lab_room TEXT NOT NULL,
        purpose TEXT NOT NULL,
        reservation_time DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`, async (err, row) => {
      if (err) {
        console.error(err.message);
        return;
      }
      if (!row) {
        const passwordHash = await bcrypt.hash('admin123', 10);
        db.run(
          `INSERT INTO users (id_number, last_name, first_name, middle_name, course_level, email, course, address, password_hash, role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['1', 'Administrator', 'System', '', 'N/A', 'admin@ccs.local', 'Administration', 'CCS Office', passwordHash, 'admin']
        );
      }
    });
  });
}

module.exports = { db, initializeDatabase };
