const { db } = require("../db");

// Notification types
const NotificationTypes = {
  RESERVATION_APPROVED: "reservation_approved",
  RESERVATION_REJECTED: "reservation_rejected",
  ANNOUNCEMENT: "announcement",
};

/**
 * Create a new notification for a user
 */
function createNotification(userId, type, title, message, referenceId = null) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO notifications (user_id, type, title, message, reference_id) VALUES (?, ?, ?, ?, ?)`,
      [userId, type, title, message, referenceId],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, userId, type, title, message, referenceId });
      }
    );
  });
}

/**
 * Get all notifications for a user (with optional limit)
 */
function getNotificationsByUserId(userId, limit = 20) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, type, title, message, is_read, reference_id, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(
          (rows || []).map((row) => ({
            id: row.id,
            type: row.type,
            title: row.title,
            message: row.message,
            isRead: row.is_read === 1,
            referenceId: row.reference_id,
            createdAt: row.created_at
              ? new Date(row.created_at).toLocaleString()
              : "-",
          }))
        );
      }
    );
  });
}

/**
 * Get unread notification count for a user
 */
function getUnreadCount(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0`,
      [userId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.count || 0);
      }
    );
  });
}

/**
 * Mark a notification as read
 */
function markAsRead(notificationId, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
      [notificationId, userId],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

/**
 * Mark all notifications as read for a user
 */
function markAllAsRead(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE notifications SET is_read = 1 WHERE user_id = ?`,
      [userId],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes);
      }
    );
  });
}

/**
 * Delete a notification
 */
function deleteNotification(notificationId, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM notifications WHERE id = ? AND user_id = ?`,
      [notificationId, userId],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

/**
 * Create a notification for reservation approval
 */
async function notifyReservationApproved(userId, reservationId, labRoom, reservationTime) {
  return createNotification(
    userId,
    NotificationTypes.RESERVATION_APPROVED,
    "Reservation Approved",
    `Your reservation for ${labRoom} at ${new Date(reservationTime).toLocaleString()} has been approved.`,
    reservationId
  );
}

/**
 * Create a notification for reservation rejection
 */
async function notifyReservationRejected(userId, reservationId, labRoom, reservationTime) {
  return createNotification(
    userId,
    NotificationTypes.RESERVATION_REJECTED,
    "Reservation Disapproved",
    `Your reservation for ${labRoom} at ${new Date(reservationTime).toLocaleString()} has been disapproved.`,
    reservationId
  );
}

/**
 * Create a notification for new announcement (for all non-admin users)
 */
async function notifyNewAnnouncementToAllUsers(author, announcementId) {
  return new Promise((resolve, reject) => {
    // Get all non-admin users
    db.all(
      `SELECT id FROM users WHERE role != 'admin'`,
      [],
      (err, rows) => {
        if (err) return reject(err);

        const users = rows || [];
        if (users.length === 0) return resolve([]);

        // Create notification for each user
        const promises = users.map((user) =>
          createNotification(
            user.id,
            NotificationTypes.ANNOUNCEMENT,
            "New Announcement",
            `${author} posted a new announcement: "${author.length > 20 ? author.substring(0, 20) + '...' : author}"`,
            announcementId
          )
        );

        Promise.all(promises)
          .then((notifications) => resolve(notifications))
          .catch(reject);
      }
    );
  });
}

module.exports = {
  NotificationTypes,
  createNotification,
  getNotificationsByUserId,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  notifyReservationApproved,
  notifyReservationRejected,
  notifyNewAnnouncementToAllUsers,
};