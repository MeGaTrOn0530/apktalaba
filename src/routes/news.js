const express = require('express');

const { requireAuth, requireRole } = require('../middleware/auth');
const { query, createId } = require('../db');
const { isId } = require('../utils/sql');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const newsRes = await query('SELECT * FROM news ORDER BY published_at DESC NULLS LAST');
  const userId = req.user?.id;
  const payload = [];

  for (const item of newsRes.rows) {
    const [likesCountRes, commentsCountRes, likedRes] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM news_likes WHERE news_id = $1', [item.id]),
      query('SELECT COUNT(*)::int AS count FROM news_comments WHERE news_id = $1', [item.id]),
      userId
        ? query('SELECT id FROM news_likes WHERE news_id = $1 AND user_id = $2 LIMIT 1', [item.id, userId])
        : Promise.resolve({ rowCount: 0 }),
    ]);

    payload.push({
      ...item,
      likes_count: likesCountRes.rows[0].count,
      comments_count: commentsCountRes.rows[0].count,
      liked_by_me: likedRes.rowCount > 0,
    });
  }

  return res.json(payload);
});

router.post('/', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  const { title, content, type, mediaUrl, status } = req.body || {};
  if (!title) {
    return res.status(400).json({ message: 'Sarlavha kerak' });
  }

  const result = await query(
    `INSERT INTO news (id, author_id, title, content, type, media_url, status, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING *`,
    [createId(), req.user.id, title, content ?? null, type ?? null, mediaUrl ?? null, status || 'published'],
  );
  return res.status(201).json(result.rows[0]);
});

router.patch('/:id', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  const { title, content, status } = req.body || {};
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  await query(
    `UPDATE news
     SET title = COALESCE($2, title),
         content = COALESCE($3, content),
         status = COALESCE($4, status)
     WHERE id = $1`,
    [req.params.id, title ?? null, content ?? null, status ?? null],
  );

  return res.json({ message: 'Yangilik yangilandi' });
});

router.delete('/:id', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }
  await query('DELETE FROM news WHERE id = $1', [req.params.id]);
  return res.json({ message: 'Yangilik ochirildi' });
});

router.post('/:id/like', requireAuth, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }
  const news = await query('SELECT id FROM news WHERE id = $1 LIMIT 1', [req.params.id]);
  if (news.rowCount === 0) {
    return res.status(404).json({ message: 'Yangilik topilmadi' });
  }

  await query(
    `INSERT INTO news_likes (id, news_id, user_id, created_at)
     VALUES ($1, $2, $3, NOW())
     ON DUPLICATE KEY UPDATE id = id`,
    [createId(), req.params.id, req.user.id],
  );

  const likesCount = await query('SELECT COUNT(*)::int AS count FROM news_likes WHERE news_id = $1', [req.params.id]);
  return res.json({ likes_count: likesCount.rows[0].count, liked_by_me: true });
});

router.delete('/:id/like', requireAuth, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }
  await query('DELETE FROM news_likes WHERE news_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  const likesCount = await query('SELECT COUNT(*)::int AS count FROM news_likes WHERE news_id = $1', [req.params.id]);
  return res.json({ likes_count: likesCount.rows[0].count, liked_by_me: false });
});

router.get('/:id/comments', requireAuth, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const commentsRes = await query(
    `SELECT c.id, c.user_id, c.text, c.created_at, c.updated_at,
            COALESCE(s.full_name, a.full_name, u.email, 'User') AS user_name
     FROM news_comments c
     LEFT JOIN students s ON s.user_id = c.user_id
     LEFT JOIN admins a ON a.user_id = c.user_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.news_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.id],
  );

  return res.json(
    commentsRes.rows.map((comment) => {
      const canEdit = comment.user_id === req.user.id;
      const canDelete = canEdit || ['admin', 'super'].includes(req.user.role);
      return {
        id: comment.id,
        user_id: comment.user_id,
        user_name: comment.user_name,
        text: comment.text,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        can_edit: canEdit,
        can_delete: canDelete,
      };
    }),
  );
});

router.post('/:id/comments', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ message: 'Matn kerak' });
  }
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const id = createId();
  await query(
    `INSERT INTO news_comments (id, news_id, user_id, text)
     VALUES ($1, $2, $3, $4)`,
    [id, req.params.id, req.user.id, text.trim()],
  );

  return res.status(201).json({ id });
});

router.patch('/comments/:id', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ message: 'Matn kerak' });
  }
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const commentRes = await query('SELECT user_id FROM news_comments WHERE id = $1 LIMIT 1', [req.params.id]);
  if (commentRes.rowCount === 0) {
    return res.status(404).json({ message: 'Koment topilmadi' });
  }
  if (commentRes.rows[0].user_id !== req.user.id) {
    return res.status(403).json({ message: 'Ruxsat yoq' });
  }

  await query(
    `UPDATE news_comments
     SET text = $2, updated_at = NOW()
     WHERE id = $1`,
    [req.params.id, text.trim()],
  );

  return res.json({ message: 'Koment yangilandi' });
});

router.delete('/comments/:id', requireAuth, async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }
  const commentRes = await query('SELECT user_id FROM news_comments WHERE id = $1 LIMIT 1', [req.params.id]);
  if (commentRes.rowCount === 0) {
    return res.status(404).json({ message: 'Koment topilmadi' });
  }
  const isOwner = commentRes.rows[0].user_id === req.user.id;
  const isAdmin = ['admin', 'super'].includes(req.user.role);
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Ruxsat yoq' });
  }
  await query('DELETE FROM news_comments WHERE id = $1', [req.params.id]);
  return res.json({ message: 'Koment ochirildi' });
});

module.exports = router;
