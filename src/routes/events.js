const express = require('express');

const { requireAuth, requireRole } = require('../middleware/auth');
const { query, createId } = require('../db');
const { isId } = require('../utils/sql');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  let eventsRes;

  if (req.user.role === 'admin') {
    eventsRes = await query(
      `SELECT e.*
       FROM events e
       JOIN users u ON u.id = e.curator_id
       WHERE e.curator_id = $1 OR u.role = 'super'
       ORDER BY e.start_at DESC NULLS LAST, e.created_at DESC`,
      [req.user.id],
    );
  } else if (req.user.role === 'student') {
    const studentRes = await query('SELECT curator_id FROM students WHERE user_id = $1 LIMIT 1', [req.user.id]);
    const curatorId = studentRes.rowCount > 0 ? studentRes.rows[0].curator_id : null;
    eventsRes = await query(
      `SELECT e.*
       FROM events e
       JOIN users u ON u.id = e.curator_id
       WHERE e.curator_id = $1 OR u.role = 'super'
       ORDER BY e.start_at DESC NULLS LAST, e.created_at DESC`,
      [curatorId],
    );
  } else {
    eventsRes = await query('SELECT * FROM events ORDER BY start_at DESC NULLS LAST, created_at DESC');
  }

  const events = eventsRes.rows;
  if (events.length === 0) {
    return res.json([]);
  }

  const creatorIds = Array.from(new Set(events.map((item) => item.curator_id)));
  const creatorRes = await query(
    'SELECT id, role FROM users WHERE id = ANY($1::text[])',
    [creatorIds],
  );
  const creatorRoleMap = new Map(creatorRes.rows.map((row) => [row.id, row.role]));

  let participantMap = new Map();
  if (req.user.role === 'student') {
    const eventIds = events.map((event) => event.id);
    const participantRes = await query(
      `SELECT event_id, joined_at
       FROM event_participants
       WHERE student_id = $1 AND event_id = ANY($2::text[])`,
      [req.user.id, eventIds],
    );
    participantMap = new Map(participantRes.rows.map((row) => [row.event_id, row]));
  }

  const payload = events.map((event) => {
    const creatorRole = creatorRoleMap.get(event.curator_id) || null;
    const participant = participantMap.get(event.id);
    return {
      ...event,
      creator_role: creatorRole,
      is_global: creatorRole === 'super',
      is_registered: !!participant,
      joined_at: participant?.joined_at ?? null,
    };
  });

  return res.json(payload);
});

router.post('/', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  const { title, description, startAt, endAt, type } = req.body || {};
  if (!title) {
    return res.status(400).json({ message: 'Sarlavha kerak' });
  }

  const id = createId();
  const eventRes = await query(
    `INSERT INTO events (id, curator_id, title, description, start_at, end_at, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [id, req.user.id, title, description ?? null, startAt ?? null, endAt ?? null, type ?? null],
  );

  const studentsRes = await query(
    req.user.role === 'admin'
      ? 'SELECT user_id FROM students WHERE curator_id = $1'
      : 'SELECT user_id FROM students',
    req.user.role === 'admin' ? [req.user.id] : [],
  );

  for (const student of studentsRes.rows) {
    await query(
      `INSERT INTO notifications (id, user_id, type, title, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [createId(), student.user_id, 'event', 'Yangi tadbir', title],
    );
  }

  return res.status(201).json(eventRes.rows[0]);
});

router.post('/:id/join', requireAuth, requireRole(['student']), async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const eventRes = await query('SELECT id, curator_id FROM events WHERE id = $1 LIMIT 1', [req.params.id]);
  if (eventRes.rowCount === 0) {
    return res.status(404).json({ message: 'Tadbir topilmadi' });
  }
  const event = eventRes.rows[0];

  const studentRes = await query('SELECT curator_id FROM students WHERE user_id = $1 LIMIT 1', [req.user.id]);
  const creatorRes = await query('SELECT role FROM users WHERE id = $1 LIMIT 1', [event.curator_id]);
  const isGlobal = creatorRes.rowCount > 0 && creatorRes.rows[0].role === 'super';
  const isAllowed = isGlobal || (studentRes.rowCount > 0 && event.curator_id === studentRes.rows[0].curator_id);
  if (!isAllowed) {
    return res.status(403).json({ message: 'Ruxsat yoq' });
  }

  await query(
    `INSERT INTO event_participants (id, event_id, student_id)
     VALUES ($1, $2, $3)
     ON DUPLICATE KEY UPDATE id = id`,
    [createId(), req.params.id, req.user.id],
  );

  const positionRes = await query(
    `SELECT COUNT(*)::int AS position
     FROM event_participants
     WHERE event_id = $1 AND joined_at <= (
       SELECT joined_at FROM event_participants WHERE event_id = $1 AND student_id = $2 LIMIT 1
     )`,
    [req.params.id, req.user.id],
  );

  return res.json({
    message: 'Tadbirkaga qoshildi',
    order: positionRes.rows[0]?.position ?? null,
  });
});

router.get('/:id/participants', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const eventRes = await query('SELECT id, curator_id FROM events WHERE id = $1 LIMIT 1', [req.params.id]);
  if (eventRes.rowCount === 0) {
    return res.status(404).json({ message: 'Tadbir topilmadi' });
  }
  const event = eventRes.rows[0];

  if (req.user.role === 'admin') {
    const creatorRes = await query('SELECT role FROM users WHERE id = $1 LIMIT 1', [event.curator_id]);
    const isGlobal = creatorRes.rowCount > 0 && creatorRes.rows[0].role === 'super';
    if (!isGlobal && event.curator_id !== req.user.id) {
      return res.status(403).json({ message: 'Ruxsat yoq' });
    }
  }

  const participantsRes = await query(
    `SELECT ep.student_id, ep.joined_at, s.full_name
     FROM event_participants ep
     LEFT JOIN students s ON s.user_id = ep.student_id
     WHERE ep.event_id = $1
     ORDER BY ep.joined_at ASC`,
    [req.params.id],
  );

  return res.json(
    participantsRes.rows.map((row, index) => ({
      order: index + 1,
      student_id: row.student_id,
      student_name: row.full_name ?? 'Talaba',
      joined_at: row.joined_at ?? null,
    })),
  );
});

module.exports = router;
