const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { query } = require('../db');
const { isId } = require('../utils/sql');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const notifications = await query(
    `SELECT *
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.user.id],
  );
  return res.json(notifications.rows);
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  await query(
    `UPDATE notifications
     SET read_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id],
  );
  return res.json({ message: 'Oqildi' });
});

module.exports = router;
