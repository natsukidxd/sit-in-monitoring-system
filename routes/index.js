const express = require('express');
const router = express.Router();
const { db } = require('../db');

function getTopLeaderboard() {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        u.id,
        u.id_number,
        u.first_name,
        u.last_name,
        u.course,
        u.course_level,
        COALESCE(u.manual_points, 0) AS manual_points,
        COUNT(sr.id) AS session_count,
        COALESCE(SUM((JULIANDAY(sr.time_out) - JULIANDAY(sr.time_in)) * 24), 0) AS total_hours
      FROM users u
      LEFT JOIN sitin_records sr 
        ON sr.user_id = u.id 
        AND sr.time_out IS NOT NULL
      WHERE u.role = 'student'
      GROUP BY u.id
      ORDER BY u.last_name ASC
    `;

    db.all(query, [], (err, rows) => {
      if (err) return reject(err);

      const students = (rows || []).map(student => {
        const totalHours = Number(student.total_hours || 0);
        const sessionCount = Number(student.session_count || 0);
        const manualPoints = Number(student.manual_points ?? 0);
        const computedPoints = totalHours + (sessionCount * 0.5);
        const points = computedPoints + manualPoints;
        return { ...student, total_hours: totalHours, session_count: sessionCount, points };
      });

      const maxPoints = Math.max(...students.map(s => s.points), 0);
      const maxHours = Math.max(...students.map(s => s.total_hours), 0);
      const maxTasks = Math.max(...students.map(s => s.session_count), 0);

      const scored = students.map(student => {
        const pointsNorm = maxPoints > 0 ? (student.points / maxPoints) * 100 : 0;
        const hoursNorm = maxHours > 0 ? (student.total_hours / maxHours) * 100 : 0;
        const tasksNorm = maxTasks > 0 ? (student.session_count / maxTasks) * 100 : 0;
        const finalScore = (pointsNorm * 0.5) + (hoursNorm * 0.3) + (tasksNorm * 0.2);
        return { ...student, final_score: finalScore };
      });

      scored.sort((a, b) => b.final_score - a.final_score);

      // Get top 3 with rank
      const top3 = scored.slice(0, 3).map((student, index) => ({
        ...student,
        rank: index + 1
      }));

      resolve(top3);
    });
  });
}

router.get('/', async (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "admin" ? "/admin" : "/dashboard");
  }

  try {
    const topStudents = await getTopLeaderboard();
    res.render('home', { title: 'Home', topStudents });
  } catch (error) {
    console.error(error);
    res.render('home', { title: 'Home', topStudents: [] });
  }
});

router.get('/community', (req, res) => {
  res.render('community', { title: 'Community' });
});

router.get('/about', (req, res) => {
  res.render('about', { title: 'About' });
});

router.get('/reservation', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  res.redirect('/dashboard/reservation');
});

module.exports = router;