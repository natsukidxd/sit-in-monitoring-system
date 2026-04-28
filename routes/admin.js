const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const { db } = require("../db");
const { rules } = require("../dashboardContent");
const PDFDocument = require("pdfkit");
const SoftwareImport = require("../models/softwareImport");
const {
  notifyReservationApproved,
  notifyReservationRejected,
  notifyNewAnnouncementToAllUsers,
} = require("../models/notification");

// Multer configuration for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../uploads"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'software-import-' + uniqueSuffix + '.csv');
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  }
});

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = "Please log in first.";
    return res.redirect("/auth/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    req.session.error = "Please log in first.";
    return res.redirect("/auth/login");
  }

  if (req.session.user.role !== "admin") {
    req.session.error = "You are not authorized to access that page.";
    return res.redirect("/dashboard");
  }

  next();
}

function getOne(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function getUserById(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, id_number, first_name, last_name, middle_name, email, course, course_level, address, role, image_url
       FROM users
       WHERE id = ?`,
      [userId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row);
      },
    );
  });
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n")
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function normalizeReportFilters(query = {}) {
  return {
    search: String(query.search || "").trim(),
    purpose: String(query.purpose || "").trim(),
    lab_room: String(query.lab_room || "").trim(),
    pc_number: String(query.pc_number || "").trim(),
    date_from: String(query.date_from || "").trim(),
    date_to: String(query.date_to || "").trim(),
    time_from: String(query.time_from || "").trim(),
    time_to: String(query.time_to || "").trim(),
  };
}

function buildReportWhere(filters) {
  const clauses = ["u.role = 'student'"];
  const params = [];

  if (filters.search) {
    const like = `%${filters.search}%`;
    clauses.push(
      `(u.id_number LIKE ? OR (u.first_name || ' ' || u.last_name) LIKE ? OR (u.last_name || ' ' || u.first_name) LIKE ?)`
    );
    params.push(like, like, like);
  }

  if (filters.purpose) {
    clauses.push("sr.purpose = ?");
    params.push(filters.purpose);
  }

  if (filters.lab_room) {
    clauses.push("sr.lab_room = ?");
    params.push(filters.lab_room);
  }

  if (filters.pc_number) {
    clauses.push("sr.pc_number = ?");
    params.push(filters.pc_number);
  }

  if (filters.date_from) {
    clauses.push("DATE(sr.time_in) >= DATE(?)");
    params.push(filters.date_from);
  }

  if (filters.date_to) {
    clauses.push("DATE(sr.time_in) <= DATE(?)");
    params.push(filters.date_to);
  }

  if (filters.time_from) {
    clauses.push("TIME(sr.time_in) >= TIME(?)");
    params.push(filters.time_from);
  }

  if (filters.time_to) {
    clauses.push("TIME(sr.time_in) <= TIME(?)");
    params.push(filters.time_to);
  }

  return { whereClause: clauses.join(" AND "), params };
}

function getAnnouncements(limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT id, author, body, created_at
        FROM announcements
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [limit],
      (err, rows) => {
        if (err) return reject(err);
        const mapped = (rows || []).map((item) => ({
          id: item.id,
          author: item.author,
          body: item.body,
          date: item.created_at
            ? new Date(item.created_at).toLocaleDateString()
            : "-",
        }));
        resolve(mapped);
      }
    );
  });
}

function getSafeReturnTo(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("/")) return "";
  if (raw.startsWith("//")) return "";
  return raw;
}

router.get("/reservations", requireAdmin, async (req, res) => {
  try {
    const selectedLab = req.query.lab || '524';
    
    const [pendingReservations, pcStatusCounts, pcs, reservationLogs] = await Promise.all([
      getAll(`
        SELECT r.*, u.id_number, u.first_name, u.last_name
        FROM reservations r
        JOIN users u ON u.id = r.user_id
        WHERE r.status = 'Pending'
        ORDER BY r.reservation_time ASC
      `),
      
      getAll(`
        SELECT status, COUNT(*) as count 
        FROM lab_pcs 
        WHERE lab_room = ?
        GROUP BY status
      `, [selectedLab]),
      
      getAll(`
        SELECT pc_number, status 
        FROM lab_pcs 
        WHERE lab_room = ?
        ORDER BY pc_number ASC
      `, [selectedLab]),
      
      getAll(`
        SELECT 
          r.id, 
          r.status, 
          u.first_name, 
          u.last_name, 
          r.reservation_time,
          r.lab_room,
          r.pc_number
        FROM reservations r
        JOIN users u ON u.id = r.user_id
        WHERE r.status IN ('Approved', 'Rejected')
        ORDER BY r.reservation_time DESC
        LIMIT 20
      `)
    ]);

    const statusCounts = {
      available: pcStatusCounts.find(s => s.status === 'available')?.count || 0,
      reserved: pcStatusCounts.find(s => s.status === 'reserved')?.count || 0,
      'not-available': pcStatusCounts.find(s => s.status === 'not-available')?.count || 0
    };

    res.render("admin/reservations", {
      title: "Manage Reservations",
      pendingReservations,
      statusCounts,
      pcs,
      selectedLab,
      reservationLogs
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load reservations.";
    res.redirect("/admin");
  }
});

router.post("/reservations/update-pc-status", requireAdmin, (req, res) => {
  const { pc_number, lab_room, status } = req.body;
  const returnTo = `/admin/reservations?lab=${encodeURIComponent(lab_room)}`;

  if (!pc_number || !lab_room || !status) {
    req.session.error = "PC number, lab room, and status are required.";
    return res.redirect(returnTo);
  }

  const validStatuses = ['available', 'reserved', 'not-available'];
  if (!validStatuses.includes(status)) {
    req.session.error = "Invalid status.";
    return res.redirect(returnTo);
  }

  db.run(
    `UPDATE lab_pcs SET status = ? WHERE pc_number = ? AND lab_room = ?`,
    [status, pc_number, lab_room],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to update PC status.";
        return res.redirect(returnTo);
      }

      req.session.message = `PC-${pc_number} status updated to ${status}.`;
      res.redirect(returnTo);
    }
  );
});

router.get("/", requireAdmin, async (req, res) => {
  try {
    const [
      adminUser,
      totalStudentsRow,
      totalAdminsRow,
      activeSitinsRow,
      completedSitinsRow,
      pendingReservationsRow,
      totalReservationsRow,
      recentRecords,
      pendingReservations,
      users,
      courseUsageRows,
      todaySitinsRow,
      thisWeekSitinsRow,
      uniqueLabsRow,
    ] = await Promise.all([
      getUserById(req.session.user.id),
      getOne(`SELECT COUNT(*) AS total FROM users WHERE role = 'student'`),
      getOne(`SELECT COUNT(*) AS total FROM users WHERE role = 'admin'`),
      getOne(
        `SELECT COUNT(*) AS total FROM sitin_records WHERE status = 'Active'`
      ),
      getOne(
        `SELECT COUNT(*) AS total FROM sitin_records WHERE status = 'Completed'`
      ),
      getOne(
        `SELECT COUNT(*) AS total FROM reservations WHERE status = 'Pending'`
      ),
      getOne(`SELECT COUNT(*) AS total FROM reservations`),
      getAll(`
        SELECT sr.*, u.id_number, u.first_name, u.last_name
        FROM sitin_records sr
        JOIN users u ON u.id = sr.user_id
        ORDER BY sr.time_in DESC
        LIMIT 10
      `),
      getAll(`
        SELECT r.*, u.id_number, u.first_name, u.last_name
        FROM reservations r
        JOIN users u ON u.id = r.user_id
        WHERE r.status = 'Pending'
        ORDER BY r.reservation_time ASC
        LIMIT 10
      `),
      getAll(`
        SELECT
          u.id,
          u.id_number,
          u.first_name,
          u.last_name,
          u.email,
          u.course,
          u.course_level,
          COUNT(CASE WHEN sr.status = 'Completed' THEN 1 END) AS used_sessions
        FROM users u
        LEFT JOIN sitin_records sr ON sr.user_id = u.id
        WHERE u.role = 'student'
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT 10
      `),
      getAll(`
        SELECT
          COALESCE(NULLIF(TRIM(u.course), ''), 'Unspecified') AS course,
          COUNT(sr.id) AS usage_count
        FROM sitin_records sr
        JOIN users u ON u.id = sr.user_id
        WHERE u.role = 'student'
        GROUP BY COALESCE(NULLIF(TRIM(u.course), ''), 'Unspecified')
        ORDER BY usage_count DESC
      `),
      getOne(`
        SELECT COUNT(*) AS total
        FROM sitin_records
        WHERE DATE(time_in) = DATE('now', 'localtime')
      `),
      getOne(`
        SELECT COUNT(*) AS total
        FROM sitin_records
        WHERE DATE(time_in) >= DATE('now', 'localtime', '-6 days')
      `),
      getOne(`SELECT COUNT(DISTINCT lab_room) AS total FROM sitin_records`),
    ]);

    const totalUsage = courseUsageRows.reduce(
      (sum, item) => sum + Number(item.usage_count || 0),
      0
    );
    const courseUsage = courseUsageRows.map((item) => {
      const usageCount = Number(item.usage_count || 0);
      return {
        course: item.course,
        usageCount,
        percent: totalUsage ? Math.round((usageCount / totalUsage) * 100) : 0,
      };
    });
    const utilizationRate = statsPercent(
      activeSitinsRow?.total || 0,
      totalStudentsRow?.total || 0
    );

    res.render("admin/index", {
      title: "Admin Dashboard",
      admin: adminUser,
      stats: {
        totalStudents: totalStudentsRow?.total || 0,
        totalAdmins: totalAdminsRow?.total || 0,
        activeSitins: activeSitinsRow?.total || 0,
        completedSitins: completedSitinsRow?.total || 0,
        pendingReservations: pendingReservationsRow?.total || 0,
        totalReservations: totalReservationsRow?.total || 0,
        todaySitins: todaySitinsRow?.total || 0,
        thisWeekSitins: thisWeekSitinsRow?.total || 0,
        uniqueLabsUsed: uniqueLabsRow?.total || 0,
        totalCoursesUsingLab: courseUsage.length,
        utilizationRate,
      },
      courseUsage,
      recentRecords,
      pendingReservations,
      users,
      rules,
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load admin dashboard.";
    res.redirect("/dashboard");
  }
});

router.post("/announcements", requireAdmin, async (req, res) => {
  const body = String(req.body.body || "").trim();
  const author = req.session.user?.name || "CCS Admin";
  const returnTo = String(req.body.returnTo || "/admin/announcements");

  if (!body) {
    req.session.error = "Announcement message is required.";
    return res.redirect(returnTo);
  }

  db.run(
    `INSERT INTO announcements (author, body) VALUES (?, ?)`,
    [author, body],
    async function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to post announcement.";
        return res.redirect(returnTo);
      }

      const announcementId = this.lastID;

      // Send notification to all non-admin users
      try {
        await notifyNewAnnouncementToAllUsers(author, announcementId);
      } catch (notificationErr) {
        console.error("Failed to send announcement notification:", notificationErr);
      }

      req.session.message = "Announcement posted successfully.";
      res.redirect(returnTo);
    }
  );
});

router.get("/announcements", requireAdmin, async (req, res) => {
  try {
    const announcements = await getAnnouncements(200);
    res.render("admin/announcements", {
      title: "Manage Announcements",
      announcements,
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load announcements.";
    res.redirect("/admin");
  }
});

router.post("/announcements/:id/edit", requireAdmin, (req, res) => {
  const announcementId = req.params.id;
  const body = String(req.body.body || "").trim();

  if (!body) {
    req.session.error = "Announcement message is required.";
    return res.redirect("/admin/announcements");
  }

  db.run(
    `UPDATE announcements SET body = ? WHERE id = ?`,
    [body, announcementId],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to update announcement.";
        return res.redirect("/admin/announcements");
      }
      req.session.message = this.changes
        ? "Announcement updated successfully."
        : "Announcement not found.";
      res.redirect("/admin/announcements");
    }
  );
});

router.post("/announcements/:id/delete", requireAdmin, (req, res) => {
  const announcementId = req.params.id;
  db.run(
    `DELETE FROM announcements WHERE id = ?`,
    [announcementId],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to delete announcement.";
        return res.redirect("/admin/announcements");
      }
      req.session.message = this.changes
        ? "Announcement deleted successfully."
        : "Announcement not found.";
      res.redirect("/admin/announcements");
    }
  );
});

function statsPercent(value, total) {
  if (!total) return 0;
  return Math.round((Number(value) / Number(total)) * 100);
}

router.post("/reservations/:id/approve", requireAdmin, async (req, res) => {
  try {
    // First get reservation details to send notification and update PC status
    const reservation = await new Promise((resolve, reject) => {
      db.get(
        `SELECT user_id, lab_room, pc_number, reservation_time FROM reservations WHERE id = ? AND status = 'Pending'`,
        [req.params.id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row);
        }
      );
    });

    if (!reservation) {
      req.session.message = "Reservation was already processed.";
      return res.redirect("/admin/reservations");
    }

    // Update reservation status
    db.run(
      `UPDATE reservations SET status = 'Approved' WHERE id = ? AND status = 'Pending'`,
      [req.params.id],
      async function (err) {
        if (err) {
          console.error(err);
          req.session.error = "Unable to approve reservation.";
          return res.redirect("/admin/reservations");
        }

        if (this.changes > 0) {
          // Update PC status to reserved when reservation is approved
          if (reservation.pc_number) {
            db.run(
              `UPDATE lab_pcs SET status = 'reserved' WHERE pc_number = ? AND lab_room = ?`,
              [reservation.pc_number, reservation.lab_room],
              (pcErr) => {
                if (pcErr) console.error("Failed to update PC status:", pcErr);
              }
            );
          }

          // Send notification to user
          try {
            await notifyReservationApproved(
              reservation.user_id,
              req.params.id,
              reservation.lab_room,
              reservation.reservation_time
            );
          } catch (notificationErr) {
            console.error("Failed to send approval notification:", notificationErr);
          }
        }

        req.session.message = this.changes
          ? "Reservation approved successfully."
          : "Reservation was already processed.";

        res.redirect("/admin/reservations");
      }
    );
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to approve reservation.";
    res.redirect("/admin");
  }
});

router.post("/reservations/:id/reject", requireAdmin, async (req, res) => {
  try {
    // First get reservation details to send notification
    const reservation = await new Promise((resolve, reject) => {
      db.get(
        `SELECT user_id, lab_room, reservation_time FROM reservations WHERE id = ? AND status = 'Pending'`,
        [req.params.id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row);
        }
      );
    });

    if (!reservation) {
      req.session.message = "Reservation was already processed.";
      return res.redirect("/admin/reservations");
    }

    // Update reservation status
    db.run(
      `UPDATE reservations SET status = 'Rejected' WHERE id = ? AND status = 'Pending'`,
      [req.params.id],
      async function (err) {
        if (err) {
          console.error(err);
          req.session.error = "Unable to reject reservation.";
          return res.redirect("/admin/reservations");
        }

        if (this.changes > 0) {
          // Send notification to user
          try {
            await notifyReservationRejected(
              reservation.user_id,
              req.params.id,
              reservation.lab_room,
              reservation.reservation_time
            );
          } catch (notificationErr) {
            console.error("Failed to send rejection notification:", notificationErr);
          }
        }

        req.session.message = this.changes
          ? "Reservation rejected successfully."
          : "Reservation was already processed.";

        res.redirect("/admin/reservations");
      }
    );
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to reject reservation.";
    res.redirect("/admin");
  }
});

router.post("/records/:id/timeout", requireAdmin, (req, res) => {
  db.get(
    `SELECT id, user_id, lab_room, pc_number
     FROM sitin_records
     WHERE id = ? AND status = 'Active'
     LIMIT 1`,
    [req.params.id],
    (recordErr, record) => {
      if (recordErr) {
        console.error(recordErr);
        req.session.error = "Unable to time out the sit-in record.";
        return res.redirect("/admin");
      }

      if (!record) {
        req.session.message = "No active sit-in record found.";
        return res.redirect("/admin");
      }

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(
          `UPDATE sitin_records
           SET status = 'Completed', time_out = DATETIME('now', 'localtime')
           WHERE id = ? AND status = 'Active'`,
          [record.id],
          function (updateErr) {
            if (updateErr) {
              console.error(updateErr);
              db.run("ROLLBACK");
              req.session.error = "Unable to time out the sit-in record.";
              return res.redirect("/admin");
            }

            if (!this.changes) {
              db.run("ROLLBACK");
              req.session.message = "No active sit-in record found.";
              return res.redirect("/admin");
            }

            db.run(
              `UPDATE users
               SET sessions_left = MAX(COALESCE(sessions_left, 30) - 1, 0)
               WHERE id = ? AND role = 'student'`,
              [record.user_id],
              (sessionErr) => {
                if (sessionErr) {
                  console.error(sessionErr);
                  db.run("ROLLBACK");
                  req.session.error = "Unable to update student session count.";
                  return res.redirect("/admin");
                }

                const finalize = () => {
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                      console.error(commitErr);
                      db.run("ROLLBACK");
                      req.session.error = "Unable to finalize sit-in time-out.";
                      return res.redirect("/admin");
                    }

                    req.session.message = "Sit-in record timed out successfully.";
                    return res.redirect("/admin");
                  });
                };

                if (!Number.isFinite(Number(record.pc_number))) {
                  return finalize();
                }

                db.run(
                  `UPDATE lab_pcs
                   SET status = 'available'
                   WHERE lab_room = ? AND pc_number = ? AND status = 'reserved'`,
                  [record.lab_room, Number(record.pc_number)],
                  (pcReleaseErr) => {
                    if (pcReleaseErr) {
                      console.error(pcReleaseErr);
                      db.run("ROLLBACK");
                      req.session.error = "Unable to release the assigned PC.";
                      return res.redirect("/admin");
                    }
                    return finalize();
                  }
                );
              }
            );
          }
        );
      });
    }
  );
});

router.get("/search", requireAdmin, (req, res) => {
  try {
    const searchTerm = (req.query.q || "").trim();
    const searchSql = `
      SELECT
        u.id,
        u.id_number,
        u.first_name,
        u.last_name,
        u.course,
        u.course_level,
        COALESCE(u.sessions_left, 30) AS sessions_left,
        (
          SELECT COUNT(*)
          FROM sitin_records sr
          WHERE sr.user_id = u.id AND sr.status = 'Active'
        ) AS active_sessions
      FROM users u
      WHERE u.role = 'student'
        AND (
          ? = ''
          OR
          u.id_number LIKE ?
          OR (u.first_name || ' ' || u.last_name) LIKE ?
          OR (u.last_name || ' ' || u.first_name) LIKE ?
        )
      ORDER BY u.last_name ASC, u.first_name ASC
      LIMIT 200
    `;
    const likeQuery = `%${searchTerm}%`;
    db.all(
      searchSql,
      [searchTerm, likeQuery, likeQuery, likeQuery],
      (err, rows) => {
        if (err) {
          console.error(err);
          req.session.error = "Unable to search student records.";
          return res.redirect("/admin/search");
        }

        res.render("admin/search", {
          title: "Students Information",
          query: searchTerm,
          results: rows || [],
        });
      }
    );
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to open student search.";
    res.redirect("/admin");
  }
});

// JSON endpoint used by the admin search modal (Bootstrap navbar).
// It returns matching students so the modal can show a single "Sit-in" redirect.
router.get("/student-sitin/search", requireAdmin, (req, res) => {
  try {
    const searchTerm = (req.query.q || "").trim();

    const searchSql = `
      SELECT
        u.id,
        u.id_number,
        u.first_name,
        u.last_name,
        u.course,
        u.course_level,
        COALESCE(u.sessions_left, 30) AS sessions_left,
        (
          SELECT COUNT(*)
          FROM sitin_records sr
          WHERE sr.user_id = u.id AND sr.status = 'Active'
        ) AS active_sessions
      FROM users u
      WHERE u.role = 'student'
        AND (
          ? = ''
          OR u.id_number LIKE ?
          OR (u.first_name || ' ' || u.last_name) LIKE ?
          OR (u.last_name || ' ' || u.first_name) LIKE ?
        )
      ORDER BY u.last_name ASC, u.first_name ASC
      LIMIT 25
    `;

    const likeQuery = `%${searchTerm}%`;
    db.all(
      searchSql,
      [searchTerm, likeQuery, likeQuery, likeQuery],
      (err, rows) => {
        if (err) {
          console.error(err);
          return res.status(500).json({
            ok: false,
            error: "Unable to search student records.",
          });
        }

        res.json({
          ok: true,
          query: searchTerm,
          results: rows || [],
        });
      }
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Unable to open student search.",
    });
  }
});

router.get("/student-sitin", requireAdmin, (req, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    const purposeOptions = [
      "C#",
      "C",
      "Java",
      "ASP.NET",
      "PHP",
      "Python",
      "JavaScript",
      "TypeScript",
      "Networking",
    ];
    const labOptions = ["524", "526", "528", "530", "542", "Mac"];

    const countSql = `
      SELECT COUNT(*) AS total
      FROM sitin_records sr
      JOIN users u ON u.id = sr.user_id
      WHERE sr.status = 'Active' AND u.role = 'student'
    `;

    const purposeSql = `
      SELECT
        COALESCE(NULLIF(TRIM(sr.purpose), ''), 'Unspecified') AS label,
        COUNT(DISTINCT sr.user_id) AS total
      FROM sitin_records sr
      JOIN users u ON u.id = sr.user_id
      WHERE sr.status = 'Active' AND u.role = 'student'
      GROUP BY COALESCE(NULLIF(TRIM(sr.purpose), ''), 'Unspecified')
    `;

    const labSql = `
      SELECT
        COALESCE(NULLIF(TRIM(sr.lab_room), ''), 'Unspecified') AS label,
        COUNT(DISTINCT sr.user_id) AS total
      FROM sitin_records sr
      JOIN users u ON u.id = sr.user_id
      WHERE sr.status = 'Active' AND u.role = 'student'
      GROUP BY COALESCE(NULLIF(TRIM(sr.lab_room), ''), 'Unspecified')
    `;

    const dataSql = `
      SELECT
        sr.id AS sitin_id,
        sr.user_id,
        u.id_number,
        u.first_name,
        u.last_name,
        sr.purpose,
        sr.lab_room,
        sr.time_in,
        sr.status,
        sr.pc_number
      FROM sitin_records sr
      JOIN users u ON u.id = sr.user_id
      WHERE sr.status = 'Active' AND u.role = 'student'
      ORDER BY sr.time_in DESC
      LIMIT ? OFFSET ?
    `;
    db.get(countSql, [], (countErr, countRow) => {
      if (countErr) {
        console.error(countErr);
        req.session.error = "Unable to load active sit-in sessions.";
        return res.redirect("/admin/student-sitin");
      }
      const total = Number(countRow?.total || 0);
      const totalPages = Math.max(Math.ceil(total / pageSize), 1);
      const normalizedPage = Math.min(page, totalPages);
      const normOffset = (normalizedPage - 1) * pageSize;

      db.all(purposeSql, [], (purposeErr, purposeRows) => {
        if (purposeErr) {
          console.error(purposeErr);
          req.session.error = "Unable to load active sit-in sessions.";
          return res.redirect("/admin/student-sitin");
        }

        db.all(labSql, [], (labErr, labRows) => {
          if (labErr) {
            console.error(labErr);
            req.session.error = "Unable to load active sit-in sessions.";
            return res.redirect("/admin/student-sitin");
          }

          const purposeMap = new Map(
            (purposeRows || []).map((row) => [
              String(row.label || "").trim(),
              Number(row.total || 0),
            ])
          );
          const labMap = new Map(
            (labRows || []).map((row) => [
              String(row.label || "").trim(),
              Number(row.total || 0),
            ])
          );

          const purposeCounts = purposeOptions.map((label) => purposeMap.get(label) || 0);
          const labCounts = labOptions.map((label) => labMap.get(label) || 0);

          const purposeOtherCount = Array.from(purposeMap.entries()).reduce(
            (sum, [label, value]) =>
              purposeOptions.includes(label) ? sum : sum + Number(value || 0),
            0
          );
          const labOtherCount = Array.from(labMap.entries()).reduce(
            (sum, [label, value]) =>
              labOptions.includes(label) ? sum : sum + Number(value || 0),
            0
          );

          const purposeLabels = purposeOtherCount
            ? [...purposeOptions, "Other"]
            : [...purposeOptions];
          const labLabels = labOtherCount ? [...labOptions, "Other"] : [...labOptions];
          const purposeSeries = purposeOtherCount
            ? [...purposeCounts, purposeOtherCount]
            : purposeCounts;
          const labSeries = labOtherCount ? [...labCounts, labOtherCount] : labCounts;

          const purposeMax = Math.max(...purposeSeries, 0);
          const labMax = Math.max(...labSeries, 0);

          const purposeYMax = total ? Math.max(purposeMax, 10) : 10;
          const labYMax = total ? Math.max(labMax, 10) : 10;

          db.all(dataSql, [pageSize, normOffset], (err, rows) => {
            if (err) {
              console.error(err);
              req.session.error = "Unable to load active sit-in sessions.";
              return res.redirect("/admin/student-sitin");
            }

            res.render("admin/student-sitin", {
              title: "Active Sit-in",
              results: rows || [],
              page: normalizedPage,
              pageSize,
              total,
              totalPages,
              purposeGraph: {
                labels: purposeLabels,
                counts: purposeSeries,
                yMax: purposeYMax,
              },
              labGraph: {
                labels: labLabels,
                counts: labSeries,
                yMax: labYMax,
              },
            });
          });
        });
      });
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to open active sit-in sessions.";
    res.redirect("/admin");
  }
});

router.get("/leaderboard", requireAdmin, async (req, res) => {
  try {
    // Get filter parameters
    const course = String(req.query.course || "").trim();
    const courseLevel = String(req.query.course_level || "").trim();
    const dateRange = String(req.query.date_range || "all").trim();

    // Build date filter
    let dateCondition = "";
    const dateParams = [];
    
    if (dateRange === "weekly") {
      dateCondition = "AND DATE(sr.time_in) >= DATE('now', 'localtime', '-6 days')";
    } else if (dateRange === "monthly") {
      dateCondition = "AND DATE(sr.time_in) >= DATE('now', 'localtime', 'start of month')";
    }

    // Base query to get student sit-in statistics
    let baseQuery = `
      SELECT
        u.id,
        u.id_number,
        u.first_name,
        u.last_name,
        u.middle_name,
        u.course,
        u.course_level,
        COALESCE(u.manual_points, 0) AS manual_points,
        COUNT(sr.id) AS session_count,
        COALESCE(SUM((JULIANDAY(sr.time_out) - JULIANDAY(sr.time_in)) * 24), 0) AS total_hours
      FROM users u
      LEFT JOIN sitin_records sr 
        ON sr.user_id = u.id 
        AND sr.time_out IS NOT NULL
        ${dateCondition}
      WHERE u.role = 'student'
    `;

    const params = [...dateParams];

    // Apply course filter
    if (course) {
      baseQuery += " AND u.course = ?";
      params.push(course);
    }

    // Apply course level filter
    if (courseLevel) {
      baseQuery += " AND u.course_level = ?";
      params.push(courseLevel);
    }

    baseQuery += " GROUP BY u.id ORDER BY u.last_name ASC";

    const students = await getAll(baseQuery, params);

     // Calculate points for each student
     const studentData = students.map(student => {
       const totalHours = Number(student.total_hours || 0);
       const sessionCount = Number(student.session_count || 0);
       const manualPoints = Number(student.manual_points ?? 0);
       const computedPoints = totalHours + (sessionCount * 0.5);
       const points = computedPoints + manualPoints;
       
       return {
         ...student,
         total_hours: totalHours,
         session_count: sessionCount,
         computed_points: computedPoints,
         manual_points: manualPoints,
         points
       };
    });

    // Find max values for normalization
    const maxPoints = Math.max(...studentData.map(s => s.points), 0);
    const maxHours = Math.max(...studentData.map(s => s.total_hours), 0);
    const maxTasks = Math.max(...studentData.map(s => s.session_count), 0);

    // Normalize metrics and calculate final scores
    const scoredStudents = studentData.map(student => {
      // Normalize each metric to 0-100 scale
      const pointsNorm = maxPoints > 0 ? (student.points / maxPoints) * 100 : 0;
      const hoursNorm = maxHours > 0 ? (student.total_hours / maxHours) * 100 : 0;
      const tasksNorm = maxTasks > 0 ? (student.session_count / maxTasks) * 100 : 0;

      // Calculate final weighted score
      const finalScore = (pointsNorm * 0.5) + (hoursNorm * 0.3) + (tasksNorm * 0.2);

      return {
        ...student,
        points_norm: pointsNorm,
        hours_norm: hoursNorm,
        tasks_norm: tasksNorm,
        final_score: finalScore
      };
    });

    // Sort by final score descending
    scoredStudents.sort((a, b) => b.final_score - a.final_score);

    // Calculate ranks with proper tie handling
    const rankedStudents = [];
    let currentRank = 1;
    let previousScore = null;
    let sameRankCount = 0;

    for (let i = 0; i < scoredStudents.length; i++) {
      const student = scoredStudents[i];
      
      if (previousScore !== null && Math.abs(student.final_score - previousScore) > 0.0001) {
        currentRank += sameRankCount;
        sameRankCount = 1;
      } else {
        sameRankCount++;
      }

      rankedStudents.push({
        ...student,
        rank: currentRank
      });

      previousScore = student.final_score;
    }

    // Get available courses for filter dropdown
    const courses = await getAll(`
      SELECT DISTINCT course 
      FROM users 
      WHERE role = 'student' AND course IS NOT NULL AND course != ''
      ORDER BY course ASC
    `);

    // Get available course levels
    const courseLevels = await getAll(`
      SELECT DISTINCT course_level 
      FROM users 
      WHERE role = 'student' AND course_level IS NOT NULL AND course_level != ''
      ORDER BY course_level ASC
    `);

    res.render("admin/leaderboard", {
      title: "Student Leaderboard",
      students: rankedStudents,
      filters: {
        course,
        course_level: courseLevel,
        date_range: dateRange
      },
      courses,
      courseLevels,
      originalUrl: req.originalUrl
    });

  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load leaderboard.";
    res.redirect("/admin");
  }
});

router.get("/student-sitin/available-pcs", requireAdmin, (req, res) => {
  const labRoom = String(req.query.lab_room || "").trim();
  if (!labRoom) {
    return res.status(400).json({ success: false, message: "lab_room is required." });
  }

  db.all(
    `SELECT pc_number
     FROM lab_pcs
     WHERE lab_room = ? AND status = 'available'
     ORDER BY pc_number ASC`,
    [labRoom],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Unable to load PCs." });
      }

      return res.json({
        success: true,
        lab_room: labRoom,
        pcs: (rows || []).map((row) => Number(row.pc_number)).filter((value) => Number.isFinite(value)),
      });
    }
  );
});

router.post("/student-sitin/time-in", requireAdmin, (req, res) => {
  const { student_id, lab_room, purpose, pc_number } = req.body;
  const query = (req.body.query || "").trim();
  const sid = String(req.body.sid || "").trim();
  const defaultReturnTo = query
    ? `/admin/student-sitin?q=${encodeURIComponent(query)}${sid ? `&sid=${encodeURIComponent(sid)}` : ""}`
    : "/admin/student-sitin";
  const returnTo = getSafeReturnTo(req.body.returnTo) || defaultReturnTo;
  const normalizedPc = Number(pc_number);

  if (!student_id || !lab_room || !purpose || !Number.isFinite(normalizedPc)) {
    req.session.error = "Student, lab room, PC number, and purpose are required.";
    return res.redirect(returnTo);
  }

  db.get(
    `SELECT id, first_name, last_name, sessions_left FROM users WHERE id = ? AND role = 'student'`,
    [student_id],
    (studentErr, student) => {
      if (studentErr || !student) {
        req.session.error = "Student record not found.";
        return res.redirect(returnTo);
      }

      const sessionsLeft = Number(student.sessions_left ?? 30);
      if (sessionsLeft <= 0) {
        req.session.error = "This student has no sessions left.";
        return res.redirect(returnTo);
      }

      db.get(
        `SELECT id FROM sitin_records WHERE user_id = ? AND status = 'Active' LIMIT 1`,
        [student_id],
        (activeErr, activeRow) => {
          if (activeErr) {
            console.error(activeErr);
            req.session.error = "Unable to process time-in request.";
            return res.redirect(returnTo);
          }

          if (activeRow) {
            req.session.error = "This student already has an active sit-in session.";
            return res.redirect(returnTo);
          }

          db.get(
            `SELECT id
             FROM lab_pcs
             WHERE lab_room = ? AND pc_number = ? AND status = 'available'
             LIMIT 1`,
            [lab_room, normalizedPc],
            (pcErr, pcRow) => {
              if (pcErr) {
                console.error(pcErr);
                req.session.error = "Unable to validate selected PC.";
                return res.redirect(returnTo);
              }

              if (!pcRow) {
                req.session.error = "Selected PC is not available for this lab.";
                return res.redirect(returnTo);
              }

              db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                db.run(
                  `UPDATE lab_pcs
                   SET status = 'reserved'
                   WHERE lab_room = ? AND pc_number = ? AND status = 'available'`,
                  [lab_room, normalizedPc],
                  function (reserveErr) {
                    if (reserveErr) {
                      console.error(reserveErr);
                      db.run("ROLLBACK");
                      req.session.error = "Unable to reserve selected PC.";
                      return res.redirect(returnTo);
                    }

                    if (!this.changes) {
                      db.run("ROLLBACK");
                      req.session.error = "Selected PC is no longer available.";
                      return res.redirect(returnTo);
                    }

                    db.run(
                      `INSERT INTO sitin_records (user_id, lab_room, pc_number, purpose, time_in)
                       VALUES (?, ?, ?, ?, DATETIME('now', 'localtime'))`,
                      [student_id, lab_room, normalizedPc, purpose],
                      function (insertErr) {
                        if (insertErr) {
                          console.error(insertErr);
                          db.run("ROLLBACK");
                          req.session.error = "Unable to record student time-in.";
                          return res.redirect(returnTo);
                        }

                        db.run("COMMIT", (commitErr) => {
                          if (commitErr) {
                            console.error(commitErr);
                            db.run("ROLLBACK");
                            req.session.error = "Unable to finalize time-in.";
                            return res.redirect(returnTo);
                          }

                          req.session.message = `Time-in recorded for ${student.first_name} ${student.last_name} on PC-${normalizedPc}. Session will be deducted after time-out.`;
                          res.redirect(returnTo);
                        });
                      }
                    );
                  }
                );
              });
            }
          );
        }
      );
    }
  );
});

router.post("/student-sitin/time-out", requireAdmin, (req, res) => {
  const studentId = req.body.student_id;
  const query = (req.body.query || "").trim();
  const sid = String(req.body.sid || "").trim();
  const defaultReturnTo = query
    ? `/admin/student-sitin?q=${encodeURIComponent(query)}${sid ? `&sid=${encodeURIComponent(sid)}` : ""}`
    : "/admin/student-sitin";
  const returnTo = getSafeReturnTo(req.body.returnTo) || defaultReturnTo;

  if (!studentId) {
    req.session.error = "Student is required.";
    return res.redirect(returnTo);
  }

  db.get(
    `SELECT id, first_name, last_name FROM users WHERE id = ? AND role = 'student'`,
    [studentId],
    (studentErr, student) => {
      if (studentErr || !student) {
        req.session.error = "Student record not found.";
        return res.redirect(returnTo);
      }

      db.get(
        `SELECT id, lab_room, pc_number
         FROM sitin_records
         WHERE user_id = ? AND status = 'Active'
         ORDER BY time_in DESC
         LIMIT 1`,
        [studentId],
        (activeErr, activeSession) => {
          if (activeErr) {
            console.error(activeErr);
            req.session.error = "Unable to time-out the student.";
            return res.redirect(returnTo);
          }

          if (!activeSession) {
            req.session.message = "No active sit-in record found for this student.";
            return res.redirect(returnTo);
          }

          db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run(
              `UPDATE sitin_records
               SET status = 'Completed', time_out = DATETIME('now', 'localtime')
               WHERE id = ? AND status = 'Active'`,
              [activeSession.id],
              function (updateErr) {
                if (updateErr) {
                  console.error(updateErr);
                  db.run("ROLLBACK");
                  req.session.error = "Unable to time-out the student.";
                  return res.redirect(returnTo);
                }

                if (!this.changes) {
                  db.run("ROLLBACK");
                  req.session.message = "No active sit-in record found for this student.";
                  return res.redirect(returnTo);
                }

                const finish = () => {
                  db.run("COMMIT", (commitErr) => {
                    if (commitErr) {
                      console.error(commitErr);
                      db.run("ROLLBACK");
                      req.session.error = "Unable to finalize time-out.";
                      return res.redirect(returnTo);
                    }

                    req.session.message = `Timed out ${student.first_name} ${student.last_name} successfully.`;
                    return res.redirect(returnTo);
                  });
                };

                db.run(
                  `UPDATE users
                   SET sessions_left = MAX(COALESCE(sessions_left, 30) - 1, 0)
                   WHERE id = ? AND role = 'student'`,
                  [studentId],
                  (sessionErr) => {
                    if (sessionErr) {
                      console.error(sessionErr);
                      db.run("ROLLBACK");
                      req.session.error = "Unable to update student session count.";
                      return res.redirect(returnTo);
                    }

                    if (!Number.isFinite(Number(activeSession.pc_number))) {
                      return finish();
                    }

                    db.run(
                      `UPDATE lab_pcs
                       SET status = 'available'
                       WHERE lab_room = ? AND pc_number = ? AND status = 'reserved'`,
                      [activeSession.lab_room, Number(activeSession.pc_number)],
                      (pcReleaseErr) => {
                        if (pcReleaseErr) {
                          console.error(pcReleaseErr);
                          db.run("ROLLBACK");
                          req.session.error = "Unable to release the assigned PC.";
                          return res.redirect(returnTo);
                        }
                        return finish();
                      }
                    );
                  }
                );
              }
            );
          });
        }
      );
    }
  );
});


router.get("/students/:id/edit", requireAdmin, (req, res) => {
  db.get(
    `SELECT id, id_number, first_name, last_name, middle_name, email, course, course_level, address, sessions_left
     FROM users
     WHERE id = ? AND role = 'student'`,
    [req.params.id],
    (err, student) => {
      if (err || !student) {
        req.session.error = "Student not found.";
        return res.redirect("/admin/search");
      }

      res.render("admin/student-edit", {
        title: "Edit Student",
        student,
      });
    }
  );
});

router.post("/students/:id/edit", requireAdmin, (req, res) => {
  const {
    first_name,
    last_name,
    middle_name,
    email,
    course,
    course_level,
    address,
    sessions_left,
  } = req.body;

  if (
    !first_name ||
    !last_name ||
    !email ||
    !course ||
    !course_level ||
    !address
  ) {
    req.session.error = "Please complete all required fields.";
    return res.redirect(`/admin/students/${req.params.id}/edit`);
  }

  const parsedSessionsLeft = Number.parseInt(String(sessions_left), 10);
  if (
    Number.isNaN(parsedSessionsLeft) ||
    parsedSessionsLeft < 0 ||
    parsedSessionsLeft > 30
  ) {
    req.session.error = "Sessions left must be a number from 0 to 30.";
    return res.redirect(`/admin/students/${req.params.id}/edit`);
  }

  db.run(
    `UPDATE users
     SET first_name = ?, last_name = ?, middle_name = ?, email = ?, course = ?, course_level = ?, address = ?, sessions_left = ?
     WHERE id = ? AND role = 'student'`,
    [
      first_name,
      last_name,
      middle_name || "",
      email,
      course,
      course_level,
      address,
      parsedSessionsLeft,
      req.params.id,
    ],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to update student information.";
        return res.redirect(`/admin/students/${req.params.id}/edit`);
      }

      req.session.message = this.changes
        ? "Student information updated successfully."
        : "No changes were made.";
      res.redirect("/admin/search");
    }
  );
});

router.post("/students/:id/delete", requireAdmin, (req, res) => {
  const studentId = req.params.id;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.get(
      "SELECT id FROM users WHERE id = ? AND role = 'student'",
      [studentId],
      (checkErr, student) => {
        if (checkErr || !student) {
          db.run("ROLLBACK");
          req.session.error = "Student not found.";
          return res.redirect("/admin/search");
        }

        db.run(
          "DELETE FROM sitin_records WHERE user_id = ?",
          [studentId],
          (sitinErr) => {
            if (sitinErr) {
              console.error(sitinErr);
              db.run("ROLLBACK");
              req.session.error = "Unable to delete student sit-in records.";
              return res.redirect("/admin/search");
            }

            db.run(
              "DELETE FROM reservations WHERE user_id = ?",
              [studentId],
              (resErr) => {
                if (resErr) {
                  console.error(resErr);
                  db.run("ROLLBACK");
                  req.session.error = "Unable to delete student reservations.";
                  return res.redirect("/admin/search");
                }

                db.run(
                  "DELETE FROM users WHERE id = ? AND role = 'student'",
                  [studentId],
                  function (userErr) {
                    if (userErr) {
                      console.error(userErr);
                      db.run("ROLLBACK");
                      req.session.error = "Unable to delete student.";
                      return res.redirect("/admin/search");
                    }

                    if (!this.changes) {
                      db.run("ROLLBACK");
                      req.session.error = "Student not found.";
                      return res.redirect("/admin/search");
                    }

                    db.run("COMMIT", (commitErr) => {
                      if (commitErr) {
                        console.error(commitErr);
                        db.run("ROLLBACK");
                        req.session.error = "Unable to finalize student deletion.";
                        return res.redirect("/admin/search");
                      }

                      req.session.message = "Student deleted successfully.";
                      res.redirect("/admin/search");
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

router.post("/students/reset-sessions", requireAdmin, (req, res) => {
  // New semester reset: sessions_left back to 30 for all students.
  db.run(
    `UPDATE users SET sessions_left = 30 WHERE role = 'student'`,
    [],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to reset sessions.";
        return res.redirect("/admin/search");
      }

      req.session.message = `Reset complete: Affected ${this.changes || 0} students.`;
      res.redirect("/admin/search");
    }
  );
});

// Manual Points Adjustment Endpoint
router.post("/users/:id/manual-points", requireAdmin, (req, res) => {
  const userId = req.params.id;
  const points = Number(req.body.points);
  const reason = String(req.body.reason || "").trim();
  const adminId = req.session.user.id;
  const returnTo = getSafeReturnTo(req.body.returnTo) || "/admin/leaderboard";

  // Validate input
  if (!Number.isFinite(points)) {
    req.session.error = "Please enter a valid number for points.";
    return res.redirect(returnTo);
  }

  // Enforce reasonable limits (-100 to +100 per adjustment)
  if (points < -100 || points > 100) {
    req.session.error = "Points adjustment must be between -100 and +100.";
    return res.redirect(returnTo);
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    // Update user's manual points
    db.run(
      `UPDATE users SET manual_points = manual_points + ? WHERE id = ? AND role = 'student'`,
      [points, userId],
      function (updateErr) {
        if (updateErr) {
          console.error(updateErr);
          db.run("ROLLBACK");
          req.session.error = "Unable to adjust points.";
          return res.redirect(returnTo);
        }

        if (this.changes === 0) {
          db.run("ROLLBACK");
          req.session.error = "Student not found.";
          return res.redirect(returnTo);
        }

        // Log the adjustment
        db.run(
          `INSERT INTO manual_point_logs (user_id, points_added, reason, admin_id) VALUES (?, ?, ?, ?)`,
          [userId, points, reason, adminId],
          (logErr) => {
            if (logErr) {
              console.error(logErr);
              db.run("ROLLBACK");
              req.session.error = "Unable to log adjustment.";
              return res.redirect(returnTo);
            }

            db.run("COMMIT", (commitErr) => {
              if (commitErr) {
                console.error(commitErr);
                db.run("ROLLBACK");
                req.session.error = "Unable to finalize point adjustment.";
                return res.redirect(returnTo);
              }

              const operation = points >= 0 ? "added" : "deducted";
              req.session.message = `Successfully ${operation} ${Math.abs(points)} points.`;
              res.redirect(returnTo);
            });
          }
        );
      }
    );
  });
});

router.post("/students/add", requireAdmin, async(req, res) => {
  const {
    id_number,
    last_name,
    first_name,
    middle_name,
    course_level,
    password,
    email,
    course,
    address,
  } = req.body;

  if (
    !id_number ||
    !last_name ||
    !first_name ||
    !course_level ||
    !password ||
    !email ||
    !course
  ) {
    req.session.error = "Please complete all required fields.";
    return res.redirect("/admin/search");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users (id_number, last_name, first_name, middle_name, course_level, email, course, address, password_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id_number,
      last_name,
      first_name,
      middle_name || "",
      course_level,
      email,
      course,
      address || "",
      passwordHash,
    ],
    function (err) {
      if (err) {
        req.session.error = "ID number or email already exists.";
        return res.redirect("/admin/search");
      }
      req.session.message = "Student added successfully.";
      res.redirect("/admin/search");
    }
  );
});

router.get("/feedback", requireAdmin, (req, res) => {
  db.all(
    `
      SELECT
        sf.id,
        sf.rating,
        sf.comments,
        sf.created_at,
        u.id_number,
        u.first_name,
        u.last_name,
        u.course,
        u.course_level,
        sr.lab_room,
        sr.purpose,
        sr.time_in,
        sr.time_out
      FROM sitin_feedback sf
      JOIN sitin_records sr ON sr.id = sf.sitin_record_id
      JOIN users u ON u.id = sf.user_id
      ORDER BY sf.created_at DESC
      LIMIT 2000
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        req.session.error = "Unable to load feedback.";
        return res.redirect("/admin");
      }

      res.render("admin/feedback", {
        title: "Feedback",
        feedback: rows || [],
      });
    }
  );
});

router.get("/reports", requireAdmin, (req, res) => {
  const filters = normalizeReportFilters(req.query);
  const { whereClause, params } = buildReportWhere(filters);
  const completedWhereClause = `${whereClause} AND sr.time_out IS NOT NULL`;

  const reportSql = `
    SELECT
      sr.id,
      sr.lab_room,
      sr.purpose,
      sr.status,
      sr.time_in,
      sr.time_out,
      DATE(sr.time_in) AS date,
      u.id_number,
      u.first_name,
      u.last_name,
      u.course,
      u.course_level,
      sr.pc_number
    FROM sitin_records sr
    JOIN users u ON u.id = sr.user_id
    WHERE ${completedWhereClause}
    ORDER BY sr.time_in DESC
    LIMIT 2000
  `;

  const labsSql = `
    SELECT DISTINCT lab_room
    FROM sitin_records
    WHERE lab_room IS NOT NULL AND TRIM(lab_room) <> ''
    ORDER BY lab_room ASC
  `;

  db.all(reportSql, params, (err, rows) => {
    if (err) {
      console.error(err);
      req.session.error = "Unable to load reports.";
      return res.redirect("/admin");
    }

    db.all(labsSql, [], (labsErr, labsRows) => {
      if (labsErr) {
        console.error(labsErr);
        req.session.error = "Unable to load report filters.";
        return res.redirect("/admin");
      }

      const exportQuery = new URLSearchParams(filters).toString();

      res.render("admin/reports", {
        title: "Reports",
        filters,
        records: rows || [],
        labRooms: (labsRows || []).map((item) => item.lab_room),
        exportQuery,
      });
    });
  });
});

router.get("/reports/export", requireAdmin, (req, res) => {
  const filters = normalizeReportFilters(req.query);
  filters.status = "Completed";
  const { whereClause, params } = buildReportWhere(filters);
  const completedWhereClause = `${whereClause} AND sr.time_out IS NOT NULL`;

  const reportSql = `
    SELECT
      u.id_number,
      (u.first_name || ' ' || u.last_name) AS student_name,
      COALESCE(u.course, '') AS course,
      COALESCE(u.course_level, '') AS year_level,
      sr.purpose,
      sr.pc_number,
      sr.time_in,
      COALESCE(sr.time_out, '') AS time_out,
      DATE(sr.time_in) AS date
    FROM sitin_records sr
    JOIN users u ON u.id = sr.user_id
    WHERE ${completedWhereClause}
    ORDER BY sr.time_in DESC
  `;

  db.all(reportSql, params, (err, rows) => {
    if (err) {
      console.error(err);
      req.session.error = "Unable to export reports.";
      return res.redirect("/admin/reports");
    }

    const csvHeader = [
      "ID Number",
      "Student Name",
      "Course",
      "Year Level",
      "Purpose",
      "PC",
      "Time In",
      "Time Out",
      "Date",
    ];

    const csvLines = [csvHeader.map(escapeCsv).join(",")];
    rows.forEach((row) => {
      csvLines.push(
        [
          row.id_number,
          row.student_name,
          row.course,
          row.year_level,
          row.purpose,
          row.pc_number || '',
          row.time_in,
          row.time_out,
          row.date,
        ]
          .map(escapeCsv)
          .join(",")
      );
    });

    const dateStamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sitin-report-${dateStamp}.csv"`
    );
    res.send(csvLines.join("\n"));
  });
});

router.get("/reports/export/pdf", requireAdmin, (req, res) => {
  const filters = normalizeReportFilters(req.query);
  filters.status = "Completed";
  const { whereClause, params } = buildReportWhere(filters);
  const completedWhereClause = `${whereClause} AND sr.time_out IS NOT NULL`;

  const reportSql = `
    SELECT
      u.id_number,
      (u.first_name || ' ' || u.last_name) AS student_name,
      COALESCE(u.course, '') AS course,
      COALESCE(u.course_level, '') AS year_level,
      sr.purpose,
      sr.pc_number,
      sr.time_in,
      COALESCE(sr.time_out, '') AS time_out,
      DATE(sr.time_in) AS date
    FROM sitin_records sr
    JOIN users u ON u.id = sr.user_id
    WHERE ${completedWhereClause}
    ORDER BY sr.time_in DESC
  `;

  db.all(reportSql, params, (err, rows) => {
    if (err) {
      console.error(err);
      req.session.error = "Unable to export PDF report.";
      return res.redirect("/admin/reports");
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sitin-report-${dateStamp}.pdf"`
    );

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
    });
    doc.pipe(res);

    const title = "Sit-in Monitoring System - Sit-in Report";
    doc.fontSize(16).font("Helvetica-Bold").text(title, { align: "left" });
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#111827")
      .text(`Generated: ${new Date().toLocaleString()}`);

    const filterParts = [];
    if (filters.search) filterParts.push(`Search: ${filters.search}`);
    if (filters.lab_room) filterParts.push(`Lab: ${filters.lab_room}`);
    if (filters.date_from) filterParts.push(`From: ${filters.date_from}`);
    if (filters.date_to) filterParts.push(`To: ${filters.date_to}`);
    doc
      .moveDown(0.2)
      .fontSize(10)
      .text(`Filters: ${filterParts.length ? filterParts.join(" | ") : "None"}`);
    doc.moveDown(0.6);

    const columns = [
      { key: "id_number", label: "ID", width: 60 },
      { key: "student_name", label: "Student", width: 120 },
      { key: "course", label: "Course", width: 90 },
      { key: "year_level", label: "Year", width: 40 },
      { key: "purpose", label: "Purpose", width: 200 },
      { key: "pc_number", label: "PC", width: 50 },
      { key: "time_in", label: "Time In", width: 80 },
      { key: "time_out", label: "Time Out", width: 80 },
      { key: "date", label: "Date", width: 60 },
    ];

    const rowHeight = 16;
    const headerHeight = 18;
    const startX = doc.page.margins.left;
    let y = doc.y;

    function drawHeader() {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827");
      let x = startX;
      columns.forEach((col) => {
        doc.text(col.label, x, y, { width: col.width, continued: false });
        x += col.width;
      });
      doc
        .moveTo(startX, y + headerHeight - 4)
        .lineTo(startX + columns.reduce((s, c) => s + c.width, 0), y + headerHeight - 4)
        .strokeColor("#9ca3af")
        .stroke();
      y += headerHeight;
      doc.font("Helvetica").fontSize(8).fillColor("#111827");
    }

    function ensureSpace(needed) {
      const bottomY = doc.page.height - doc.page.margins.bottom;
      if (y + needed > bottomY) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
    }

    drawHeader();

    rows.forEach((row) => {
      ensureSpace(rowHeight);
      let x = startX;
      columns.forEach((col) => {
        const text = row[col.key] ? String(row[col.key]) : "";
        doc.text(text, x, y, {
          width: col.width,
          height: rowHeight,
          ellipsis: true,
        });
        x += col.width;
      });
      y += rowHeight;
    });

    doc.end();
  });
});

// ==============================================
// SOFTWARE IMPORT MODULE
// ==============================================

/**
 * Software Import Page
 * GET /admin/software-import
 */
router.get("/software-import", requireAdmin, async (req, res) => {
  try {
    const history = await SoftwareImport.getImportHistory(20);
    
    res.render("admin/software-import/upload", {
      title: "Software Management",
      history,
      message: req.session.message,
      error: req.session.error
    });
    
    delete req.session.message;
    delete req.session.error;
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load software import page.";
    res.redirect("/admin");
  }
});

/**
 * Handle CSV File Upload
 * POST /admin/software-import/upload
 */
router.post("/software-import/upload", requireAdmin, upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      req.session.error = "Please select a CSV file to upload.";
      return res.redirect("/admin/software-import");
    }

    // Parse CSV file
    const parsedData = await SoftwareImport.parseCSV(req.file.path);
    
    if (parsedData.length === 0) {
      SoftwareImport.cleanupTempFile(req.file.path);
      req.session.error = "No valid software entries found in CSV file.";
      return res.redirect("/admin/software-import");
    }

    // Store parsed data in session for preview
    req.session.pendingSoftwareImport = {
      data: parsedData,
      filename: req.file.originalname,
      tempPath: req.file.path
    };

    // Redirect to preview page
    res.redirect("/admin/software-import/preview");

  } catch (error) {
    console.error("CSV upload error:", error);
    if (req.file) {
      SoftwareImport.cleanupTempFile(req.file.path);
    }
    req.session.error = "Failed to process CSV file: " + error.message;
    res.redirect("/admin/software-import");
  }
});

/**
 * Preview Page
 * GET /admin/software-import/preview
 */
router.get("/software-import/preview", requireAdmin, (req, res) => {
  if (!req.session.pendingSoftwareImport) {
    req.session.error = "No pending import found. Please upload a CSV file first.";
    return res.redirect("/admin/software-import");
  }

  const { data, filename } = req.session.pendingSoftwareImport;
  const grouped = SoftwareImport.groupByLab(data);
  const labCount = Object.keys(grouped).length;
  const totalSoftware = data.length;
  const uniqueSoftware = new Set(data.map(i => i.software)).size;

  res.render("admin/software-import/preview", {
    title: "Preview Software Import",
    grouped,
    filename,
    labCount,
    totalSoftware,
    uniqueSoftware
  });
});

/**
 * Confirm and Execute Import
 * POST /admin/software-import/confirm
 */
router.post("/software-import/confirm", requireAdmin, async (req, res) => {
  try {
    if (!req.session.pendingSoftwareImport) {
      req.session.error = "No pending import found.";
      return res.redirect("/admin/software-import");
    }

    const { data, filename, tempPath } = req.session.pendingSoftwareImport;
    
    // Perform full import
    const result = await SoftwareImport.performImport(
      data, 
      req.session.user.id, 
      filename
    );

    // Cleanup
    SoftwareImport.cleanupTempFile(tempPath);
    delete req.session.pendingSoftwareImport;

    res.render("admin/software-import/result", {
      title: "Import Complete",
      success: true,
      result,
      filename
    });

  } catch (error) {
    console.error("Import error:", error);
    res.render("admin/software-import/result", {
      title: "Import Failed",
      success: false,
      error: error.message
    });
  }
});

/**
 * Cancel Import
 * POST /admin/software-import/cancel
 */
router.post("/software-import/cancel", requireAdmin, (req, res) => {
  if (req.session.pendingSoftwareImport) {
    SoftwareImport.cleanupTempFile(req.session.pendingSoftwareImport.tempPath);
    delete req.session.pendingSoftwareImport;
  }
  
  req.session.message = "Import cancelled.";
  res.redirect("/admin/software-import");
});

/**
 * Download CSV Template
 * GET /admin/software-import/template
 */
router.get("/software-import/template", requireAdmin, (req, res) => {
  // Standard labs used in the system
  const standardLabs = ['524', '526', '528', '530', '542', 'Mac'];
  
  // Generate CSV header row with lab names
  const csvHeader = standardLabs.join(',');
  
  // Set response headers for CSV download
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="software-import-template.csv"');
  
  // Send CSV content
  res.send(csvHeader);
});

module.exports = router;
