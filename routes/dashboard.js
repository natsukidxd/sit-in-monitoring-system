const express = require('express');
const { db } = require('../db');

const router = express.Router();
const MAX_SESSIONS = 30;

const announcements = [
  {
    author: 'CCS Admin',
    date: '2026-Feb-11',
    body: 'Please keep your reservation details updated before your scheduled laboratory use.'
  },
  {
    author: 'CCS Admin',
    date: '2024-May-08',
    body: 'Important Announcement: We are excited to announce the launch of our new website. Explore our latest products and services now!'
  }
];

const rules = [
  'Maintain silence, proper decorum, and discipline inside the laboratory. Mobile phones, walkmans, and other personal pieces of equipment must be switched off.',
  'Games are not allowed inside the lab. This includes computer-related games, card games, and other games that may disturb the operation of the lab.',
  'Surfing the internet is allowed only with the permission of the instructor. Downloading and installing software are strictly prohibited unless authorized.',
  'Observe cleanliness and proper use of all laboratory equipment at all times.'
];

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = 'Please log in first.';
    return res.redirect('/auth/login');
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
    address: user.address
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
      `SELECT * FROM sitin_records WHERE user_id = ? ORDER BY time_in DESC`,
      [userId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
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
      }
    );
  });
}

router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const [user, records, reservations] = await Promise.all([
      getUserById(userId),
      getRecords(userId),
      getReservations(userId)
    ]);

    if (user) refreshSessionUser(req, user);

    const completedSessions = records.filter(record => record.status === 'Completed').length;
    const activeSessions = records.filter(record => record.status === 'Active').length;
    const pendingReservations = reservations.filter(item => item.status === 'Pending').length;

    res.render('dashboard/index', {
      title: 'Dashboard',
      user,
      announcements,
      rules,
      records,
      reservations,
      activeSessions,
      completedSessions,
      remainingSessions: Math.max(0, MAX_SESSIONS - completedSessions),
      pendingReservations
    });
  } catch (error) {
    console.error(error);
    req.session.error = 'Unable to load dashboard.';
    res.redirect('/');
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const records = await getRecords(req.session.user.id);
    res.render('dashboard/history', {
      title: 'History',
      records
    });
  } catch (error) {
    console.error(error);
    req.session.error = 'Unable to load history.';
    res.redirect('/dashboard');
  }
});

router.get('/reservation', requireAuth, async (req, res) => {
  try {
    const [user, reservations, records] = await Promise.all([
      getUserById(req.session.user.id),
      getReservations(req.session.user.id),
      getRecords(req.session.user.id)
    ]);

    if (user) refreshSessionUser(req, user);

    const completedSessions = records.filter(record => record.status === 'Completed').length;

    res.render('dashboard/reservation', {
      title: 'Reservation',
      user,
      reservations,
      remainingSessions: Math.max(0, MAX_SESSIONS - completedSessions)
    });
  } catch (error) {
    console.error(error);
    req.session.error = 'Unable to load reservation page.';
    res.redirect('/dashboard');
  }
});

router.post('/reservation', requireAuth, async (req, res) => {
  const { lab_room, purpose, reservation_date, reservation_time } = req.body;
  const reservationTime = formatDateTime(reservation_date, reservation_time);

  if (!lab_room || !purpose || !reservationTime) {
    req.session.error = 'Please complete the reservation form.';
    return res.redirect('/dashboard/reservation');
  }

  db.run(
    `INSERT INTO reservations (user_id, lab_room, purpose, reservation_time) VALUES (?, ?, ?, ?)`,
    [req.session.user.id, lab_room, purpose, reservationTime],
    function (err) {
      if (err) {
        console.error(err);
        req.session.error = 'Unable to save reservation.';
        return res.redirect('/dashboard/reservation');
      }

      req.session.message = 'Reservation submitted successfully.';
      res.redirect('/dashboard/reservation');
    }
  );
});

router.get('/profile', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.session.user.id);
    if (user) refreshSessionUser(req, user);
    res.render('dashboard/profile', {
      title: 'Edit Profile',
      user
    });
  } catch (error) {
    console.error(error);
    req.session.error = 'Unable to load profile.';
    res.redirect('/dashboard');
  }
});

router.post('/profile', requireAuth, (req, res) => {
  const {
    last_name,
    first_name,
    middle_name,
    course_level,
    email,
    course,
    address
  } = req.body;

  if (!last_name || !first_name || !course_level || !email || !course || !address) {
    req.session.error = 'Please complete all required fields.';
    return res.redirect('/dashboard/profile');
  }

  db.run(
    `UPDATE users
     SET last_name = ?, first_name = ?, middle_name = ?, course_level = ?, email = ?, course = ?, address = ?
     WHERE id = ?`,
    [last_name, first_name, middle_name || '', course_level, email, course, address, req.session.user.id],
    async function (err) {
      if (err) {
        console.error(err);
        req.session.error = 'Unable to update profile. Email may already be in use.';
        return res.redirect('/dashboard/profile');
      }

      const updatedUser = await getUserById(req.session.user.id);
      if (updatedUser) refreshSessionUser(req, updatedUser);

      req.session.message = 'Profile updated successfully.';
      res.redirect('/dashboard/profile');
    }
  );
});

router.post('/time-in', requireAuth, (req, res) => {
  const { lab_room, purpose } = req.body;
  const userId = req.session.user.id;

  if (!lab_room || !purpose) {
    req.session.error = 'Lab room and purpose are required.';
    return res.redirect('/dashboard');
  }

  db.get(
    `SELECT id FROM sitin_records WHERE user_id = ? AND status = 'Active' LIMIT 1`,
    [userId],
    (err, row) => {
      if (row) {
        req.session.error = 'You already have an active sit-in session.';
        return res.redirect('/dashboard');
      }

      db.run(
        `INSERT INTO sitin_records (user_id, lab_room, purpose) VALUES (?, ?, ?)`,
        [userId, lab_room, purpose],
        () => {
          req.session.message = 'Time-in recorded successfully.';
          res.redirect('/dashboard/history');
        }
      );
    }
  );
});

router.post('/time-out/:id', requireAuth, (req, res) => {
  const recordId = req.params.id;
  const userId = req.session.user.id;

  db.run(
    `UPDATE sitin_records
     SET status = 'Completed', time_out = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'Active'`,
    [recordId, userId],
    function () {
      req.session.message = this.changes ? 'Time-out recorded successfully.' : 'No active record found.';
      res.redirect('/dashboard/history');
    }
  );
});

module.exports = router;
