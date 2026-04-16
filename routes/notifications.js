const express = require("express");
const {
  getNotificationsByUserId,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
} = require("../models/notification");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Get all notifications for the current user (API endpoint)
router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "20", 10);
    const notifications = await getNotificationsByUserId(req.session.user.id, limit);
    res.json({ success: true, notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, error: "Unable to fetch notifications" });
  }
});

// Get unread notification count (API endpoint)
router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const count = await getUnreadCount(req.session.user.id);
    res.json({ success: true, count });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({ success: false, error: "Unable to fetch unread count" });
  }
});

// Mark a notification as read (API endpoint)
router.post("/:id/mark-read", requireAuth, async (req, res) => {
  try {
    const success = await markAsRead(req.params.id, req.session.user.id);
    if (success) {
      res.json({ success: true, message: "Notification marked as read" });
    } else {
      res.status(404).json({ success: false, error: "Notification not found" });
    }
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ success: false, error: "Unable to mark notification as read" });
  }
});

// Mark all notifications as read (API endpoint)
router.post("/mark-all-read", requireAuth, async (req, res) => {
  try {
    const count = await markAllAsRead(req.session.user.id);
    res.json({ success: true, message: `${count} notifications marked as read` });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({ success: false, error: "Unable to mark all notifications as read" });
  }
});

// Delete a notification (API endpoint)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const success = await deleteNotification(req.params.id, req.session.user.id);
    if (success) {
      res.json({ success: true, message: "Notification deleted" });
    } else {
      res.status(404).json({ success: false, error: "Notification not found" });
    }
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ success: false, error: "Unable to delete notification" });
  }
});

module.exports = router;