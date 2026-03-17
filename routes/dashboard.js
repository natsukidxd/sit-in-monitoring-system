const express = require('express');
const { db } = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = 'Please log in first.';
    return res.redirect('/auth/login');
  }
  next();
}

router.get('/', requireAuth, (req, res) => {
  const userId = req.session.user.id;

  db.all(
    `SELECT * FROM sitin_records WHERE user_id = ? ORDER BY time_in DESC`,
    [userId],
    (err, records) => {
      if (err) {
        return res.render('dashboard/index', {
          title: 'Dashboard',
          records: [],
          totalSessions: 0,
          activeSessions: 0
        });
      }

      const totalSessions = records.length;
      const activeSessions = records.filter(record => record.status === 'Active').length;

      res.render('dashboard/index', {
        title: 'Dashboard',
        records,
        totalSessions,
        activeSessions
      });
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
          res.redirect('/dashboard');
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
      res.redirect('/dashboard');
    }
  );
});

module.exports = router;
