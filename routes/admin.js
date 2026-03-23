const express = require("express");
const { db } = require("../db");
const { announcements, rules } = require("../dashboardContent");

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
    ]);

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
      },
      recentRecords,
      pendingReservations,
      users,
      announcements,
      rules,
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load admin dashboard.";
    res.redirect("/dashboard");
  }
});

router.post("/reservations/:id/approve", requireAdmin, (req, res) => {
  db.run(
    `UPDATE reservations SET status = 'Approved' WHERE id = ? AND status = 'Pending'`,
    [req.params.id],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to approve reservation.";
        return res.redirect("/admin");
      }

      req.session.message = this.changes
        ? "Reservation approved successfully."
        : "Reservation was already processed.";

      res.redirect("/admin");
    }
  );
});

router.post("/reservations/:id/reject", requireAdmin, (req, res) => {
  db.run(
    `UPDATE reservations SET status = 'Rejected' WHERE id = ? AND status = 'Pending'`,
    [req.params.id],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to reject reservation.";
        return res.redirect("/admin");
      }

      req.session.message = this.changes
        ? "Reservation rejected successfully."
        : "Reservation was already processed.";

      res.redirect("/admin");
    }
  );
});

router.post("/records/:id/timeout", requireAdmin, (req, res) => {
  db.run(
    `
      UPDATE sitin_records
      SET status = 'Completed', time_out = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'Active'
    `,
    [req.params.id],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to time out the sit-in record.";
        return res.redirect("/admin");
      }

      req.session.message = this.changes
        ? "Sit-in record timed out successfully."
        : "No active sit-in record found.";

      res.redirect("/admin");
    }
  );
});

module.exports = router;
