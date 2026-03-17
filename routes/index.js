const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('home', { title: 'Home' });
});

router.get('/community', (req, res) => {
  res.render('community', { title: 'Community' });
});

router.get('/about', (req, res) => {
  res.render('about', { title: 'About' });
});

router.get('/reservation', (req, res) => {
  res.render('reservation', { title: 'Reservation'});
});

module.exports = router;
