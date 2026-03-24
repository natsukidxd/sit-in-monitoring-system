const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const { announcements: defaultAnnouncements } = require("./dashboardContent");

const dbPath = path.join(__dirname, "data", "sitin.sqlite");
const db = new sqlite3.Database(dbPath);

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_number TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        middle_name TEXT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        course TEXT,
        course_level TEXT,
        address TEXT,
        role TEXT DEFAULT 'student',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        image_url TEXT DEFAULT 'default.png',
        sessions_left INTEGER NOT NULL DEFAULT 30
      )
    `);

    // Lightweight migration for older databases (already created without sessions_left).
    db.all(`PRAGMA table_info(users)`, [], (err, columns) => {
      if (err) {
        console.error(err.message);
        return;
      }

      const hasSessionsLeft = (columns || []).some(
        (col) => col?.name === "sessions_left"
      );
      if (!hasSessionsLeft) {
        db.run(
          `ALTER TABLE users ADD COLUMN sessions_left INTEGER NOT NULL DEFAULT 30`,
          (alterErr) => {
            if (alterErr) console.error(alterErr.message);
          }
        );
      }

      // Ensure any legacy rows have a valid value.
      db.run(
        `UPDATE users SET sessions_left = 30 WHERE sessions_left IS NULL`,
        (updateErr) => {
          if (updateErr) console.error(updateErr.message);
        }
      );
    });

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

    db.run(`
      CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sitin_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sitin_record_id INTEGER NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        rating INTEGER NOT NULL,
        comments TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sitin_record_id) REFERENCES sitin_records(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.get(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
      async (err, row) => {
        if (err) {
          console.error(err.message);
          return;
        }
        if (!row) {
          const passwordHash = await bcrypt.hash("admin123", 10);
          db.run(
            `INSERT INTO users (id_number, last_name, first_name, middle_name, course_level, email, course, address, password_hash, role, sessions_left)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              "1",
              "Administrator",
              "System",
              "",
              "N/A",
              "admin@ccs.local",
              "Administration",
              "CCS Office",
              passwordHash,
              "admin",
              30,
            ],
          );
        }
      },
    );

    db.get(`SELECT COUNT(*) AS total FROM announcements`, [], (countErr, row) => {
      if (countErr) {
        console.error(countErr.message);
        return;
      }

      if ((row?.total || 0) > 0) return;

      (defaultAnnouncements || []).forEach((item) => {
        db.run(
          `INSERT INTO announcements (author, body) VALUES (?, ?)`,
          [item.author || "CCS Admin", item.body || ""],
          (insertErr) => {
            if (insertErr) console.error(insertErr.message);
          }
        );
      });
    });
  });
}

module.exports = { db, initializeDatabase };
