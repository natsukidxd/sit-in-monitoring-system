const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const expressLayouts = require('express-ejs-layouts');
const { initializeDatabase } = require('./db');

const app = express();
const PORT = 8080;

initializeDatabase();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'partials/layout');
app.use(expressLayouts);

// ❌ REMOVE duplicate static (you had two)
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: './data' }),
    secret: 'sit-in-monitoring-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 2 }
  })
);

// locals
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.path = req.path;
  res.locals.message = req.session.message || null;
  res.locals.error = req.session.error || null;
  delete req.session.message;
  delete req.session.error;
  next();
});

// routes
app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/admin', require('./routes/admin'));


// ✅ PROTECTED IMAGE ROUTE (FIXED + SECURE)
app.get("/profile-image/:filename", (req, res) => {
  if (!req.session.user) return res.sendStatus(403);

  // 🔒 only allow own image OR admin
  if (
    req.session.user.role !== "admin" &&
    req.session.user.image_url !== req.params.filename
  ) {
    return res.sendStatus(403);
  }

  const filePath = path.join(__dirname, "uploads/profiles", req.params.filename);

  // ✅ fallback if file does not exist
  if (!fs.existsSync(filePath)) {
    return res.sendFile(
      path.join(__dirname, "uploads/profiles/default.png")
    );
  }

  res.sendFile(filePath);
});


// 404
app.use((req, res) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});