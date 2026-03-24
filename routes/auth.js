const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("auth/login", { title: "Login" });
});

router.post("/login", (req, res) => {
  const { id_number, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE id_number = ?`,
    [id_number.toString().toUpperCase()],
    async (err, user) => {
      if (err) {
        req.session.error = "An unexpected error occurred.";
        return res.redirect("/auth/login");
      }

      if (!user) {
        req.session.error = "Invalid ID number or password.";
        return res.redirect("/auth/login");
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        req.session.error = "Invalid ID number or password.";
        return res.redirect("/auth/login");
      }

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
        sessions_left: user.sessions_left ?? 30,
      };

      req.session.message = `Welcome back, ${user.first_name}!`;
      // Used by the shared layout to show a login success popup/toast.
      req.session.login_success = true;
      res.redirect(user.role === "admin" ? "/admin" : "/dashboard");
    }
  );
});

router.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("auth/register", { title: "Register" });
});

router.post("/register", async (req, res) => {
  const {
    id_number,
    last_name,
    first_name,
    middle_name,
    course_level,
    password,
    confirm_password,
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
    !confirm_password ||
    !email ||
    !course ||
    !address
  ) {
    req.session.error = "Please complete all required fields.";
    return res.redirect("/auth/register");
  }

  if (password !== confirm_password) {
    req.session.error = "Passwords do not match.";
    return res.redirect("/auth/register");
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
      address,
      passwordHash,
    ],
    function (err) {
      if (err) {
        req.session.error = "ID number or email already exists.";
        return res.redirect("/auth/register");
      }
      req.session.message = "Registration successful. You can now log in.";
      res.redirect("/auth/login");
    }
  );
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/auth/login");
  });
});

module.exports = router;
