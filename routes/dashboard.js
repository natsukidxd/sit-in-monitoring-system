const express = require("express");
const path = require("path");
const { db } = require("../db");
const multer = require("multer");
const router = express.Router();

const { announcements, rules } = require("../dashboardContent");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "../uploads/profiles"));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const safeName = `${req.session.user.id_number}-${Date.now()}${ext}`;
    cb(null, safeName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp/;
  const extValid = allowedTypes.test(
    path.extname(file.originalname).toLowerCase(),
  );
  const mimeValid = allowedTypes.test(file.mimetype);

  if (extValid && mimeValid) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, JPEG, PNG, and WEBP files are allowed."));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = "Please log in first.";
    return res.redirect("/auth/login");
  }
  next();
}

function formatDateTime(date, time) {
  if (!date || !time) return null;
  return `${date} ${time}:00`;
}

function refreshSessionUser(req, user) {
  req.session.user = {
    id: user.id,
    id_number: user.id_number,
    name: `${user.first_name} ${user.last_name}`,
    role: user.role,
    course: user.course,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    middle_name: user.middle_name,
    course_level: user.course_level,
    address: user.address,
    image_url: user.image_url || "/images/profiles/default.png",
    sessions_left: user.sessions_left ?? 30,
  };
}

function getUserById(userId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getRecords(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT
          sr.*,
          sf.id AS feedback_id,
          sf.rating AS feedback_rating,
          sf.comments AS feedback_comments,
          sf.created_at AS feedback_created_at
        FROM sitin_records sr
        LEFT JOIN sitin_feedback sf ON sf.sitin_record_id = sr.id
        WHERE sr.user_id = ?
        ORDER BY sr.time_in DESC
      `,
      [userId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      },
    );
  });
}

function getReservations(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM reservations WHERE user_id = ? ORDER BY reservation_time DESC`,
      [userId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      },
    );
  });
}

router.get("/", requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const user = await getUserById(userId);

    if (user) refreshSessionUser(req, user);

    res.render("dashboard/index", {
      title: "Dashboard",
      user,
      announcements,
      rules,
      remainingSessions: Math.max(0, Number(user?.sessions_left ?? 30)),
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load dashboard.";
    res.redirect("/");
  }
});

router.get("/history", requireAuth, async (req, res) => {
  try {
    const records = await getRecords(req.session.user.id);
    res.render("dashboard/history", {
      title: "History",
      records,
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load history.";
    res.redirect("/dashboard");
  }
});

router.get("/reservation", requireAuth, async (req, res) => {
  try {
    const [user, reservations] = await Promise.all([
      getUserById(req.session.user.id),
      getReservations(req.session.user.id),
    ]);

    if (user) refreshSessionUser(req, user);

    res.render("dashboard/reservation", {
      title: "Reservation",
      user,
      reservations,
      remainingSessions: Math.max(0, Number(user?.sessions_left ?? 30)),
    });
  } catch (error) {
    console.error(error);
    req.session.error = "Unable to load reservation page.";
    res.redirect("/dashboard");
  }
});

router.post("/reservation", requireAuth, async (req, res) => {
  const { lab_room, purpose, reservation_date, reservation_time } = req.body;
  const reservationTime = formatDateTime(reservation_date, reservation_time);

  if (!lab_room || !purpose || !reservationTime) {
    req.session.error = "Please complete the reservation form.";
    return res.redirect("/dashboard/reservation");
  }

  db.run(
    `INSERT INTO reservations (user_id, lab_room, purpose, reservation_time) VALUES (?, ?, ?, ?)`,
    [req.session.user.id, lab_room, purpose, reservationTime],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = "Unable to save reservation.";
        return res.redirect("/dashboard/reservation");
      }

      req.session.message = "Reservation submitted successfully.";
      res.redirect("/dashboard/reservation");
    },
  );
});

router.get("/profile", requireAuth, (req, res) => {
  db.get(
    `SELECT id, id_number, first_name, last_name, middle_name, email, course, course_level, address, image_url
     FROM users
     WHERE id = ?`,
    [req.session.user.id],
    (err, user) => {
      if (err || !user) {
        req.session.error = "Unable to load profile.";
        return res.redirect("/dashboard");
      }

      res.render("dashboard/profile", {
        title: "Edit Profile",
        user,
      });
    },
  );
});

router.post(
  "/profile",
  requireAuth,
  upload.single("profile_image"),
  (req, res) => {
    const {
      first_name,
      last_name,
      middle_name,
      email,
      course,
      course_level,
      address,
    } = req.body;

    db.get(
      "SELECT image_url FROM users WHERE id = ?",
      [req.session.user.id],
      (fetchErr, existingUser) => {
        if (fetchErr || !existingUser) {
          req.session.error = "Unable to update profile.";
          return res.redirect("/dashboard/profile");
        }

        const imageUrl = req.file
          ? req.file.filename
          : existingUser.image_url || "default.png";

        db.run(
          `UPDATE users
         SET first_name = ?, last_name = ?, middle_name = ?, email = ?, course = ?, course_level = ?, address = ?, image_url = ?
         WHERE id = ?`,
          [
            first_name,
            last_name,
            middle_name,
            email,
            course,
            course_level,
            address,
            imageUrl,
            req.session.user.id,
          ],
          function (err) {
            if (err) {
              console.error(err);
              req.session.error = "Failed to update profile.";
              return res.redirect("/dashboard/profile");
            }

            req.session.user.first_name = first_name;
            req.session.user.last_name = last_name;
            req.session.user.email = email;
            req.session.user.course = course;
            req.session.user.course_level = course_level;
            req.session.user.address = address;
            req.session.user.image_url = imageUrl;

            req.session.message = "Profile updated successfully.";
            res.redirect("/dashboard/profile");
          },
        );
      },
    );
  },
);

router.post("/time-out/:id", requireAuth, (req, res) => {
  const recordId = req.params.id;
  const userId = req.session.user.id;
  const returnTo = req.query.returnTo || "/dashboard/history";

  db.run(
    `UPDATE sitin_records
     SET status = 'Completed', time_out = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'Active'`,
    [recordId, userId],
    function () {
      req.session.message = this.changes
        ? "Time-out recorded successfully."
        : "No active record found.";
      res.redirect(returnTo);
    },
  );
});

router.post("/feedback/:recordId", requireAuth, (req, res) => {
  const recordId = req.params.recordId;
  const userId = req.session.user.id;
  const rating = Number.parseInt(String(req.body.rating || ""), 10);
  const comments = String(req.body.comments || "").trim();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    req.session.error = "Please select a rating from 1 to 5.";
    return res.redirect("/dashboard/history");
  }

  db.get(
    `SELECT id, status FROM sitin_records WHERE id = ? AND user_id = ?`,
    [recordId, userId],
    (recordErr, record) => {
      if (recordErr || !record) {
        req.session.error = "Sit-in record not found.";
        return res.redirect("/dashboard/history");
      }

      if (record.status !== "Completed") {
        req.session.error = "You can only submit feedback for completed sit-ins.";
        return res.redirect("/dashboard/history");
      }

      db.get(
        `SELECT id FROM sitin_feedback WHERE sitin_record_id = ? LIMIT 1`,
        [recordId],
        (existingErr, existing) => {
          if (existingErr) {
            console.error(existingErr);
            req.session.error = "Unable to submit feedback.";
            return res.redirect("/dashboard/history");
          }

          if (existing) {
            req.session.error = "Feedback was already submitted for this sit-in.";
            return res.redirect("/dashboard/history");
          }

          db.run(
            `INSERT INTO sitin_feedback (sitin_record_id, user_id, rating, comments) VALUES (?, ?, ?, ?)`,
            [recordId, userId, rating, comments],
            function (insertErr) {
              if (insertErr) {
                console.error(insertErr);
                req.session.error = "Unable to submit feedback.";
                return res.redirect("/dashboard/history");
              }

              req.session.message = "Thank you! Your feedback has been submitted.";
              res.redirect("/dashboard/history");
            }
          );
        }
      );
    }
  );
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    req.session.error =
      err.code === "LIMIT_FILE_SIZE"
        ? "Profile image must be less than 2MB."
        : "Upload error.";
    return res.redirect("/dashboard/profile");
  }

  if (err) {
    req.session.error = err.message || "Something went wrong during upload.";
    return res.redirect("/dashboard/profile");
  }

  next();
});

module.exports = router;
