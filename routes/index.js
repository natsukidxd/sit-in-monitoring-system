const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === "admin" ? "/admin" : "/dashboard");
  }
  res.render('home', { title: 'Home' });
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
