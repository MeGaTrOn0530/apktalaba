const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { query, createId } = require('../db');
const { isId } = require('../utils/sql');

const router = express.Router();

router.get('/', requireAuth, async (_req, res) => {
  const discussions = await query('SELECT * FROM discussions ORDER BY created_at DESC');
  return res.json(discussions.rows);
});

router.post('/', requireAuth, async (req, res) => {
  const { title, scope } = req.body || {};
  if (!title) {
    return res.status(400).json({ message: 'Sarlavha kerak' });
  }

  const discussion = await query(
    `INSERT INTO discussions (id, title, created_by, scope)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [createId(), title, req.user.id, scope ?? null],
  );
  return res.status(201).json(discussion.rows[0]);
});

router.post('/:id/posts', requireAuth, async (req, res) => {
  const { content } = req.body || {};
  if (!content) {
    return res.status(400).json({ message: 'Matn kerak' });
  }
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  await query(
    `INSERT INTO discussion_posts (id, discussion_id, user_id, content)
     VALUES ($1, $2, $3, $4)`,
    [createId(), req.params.id, req.user.id, content],
  );
  return res.status(201).json({ message: 'Post yaratildi' });
});

module.exports = router;
