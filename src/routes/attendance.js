const express = require('express');

const { requireAuth, requireRole } = require('../middleware/auth');
const { query, createId } = require('../db');

const router = express.Router();

function toDateKey(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function weekDateKeys(anchorDate) {
  const date = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate());
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  const keys = [];
  for (let i = 0; i < 5; i += 1) {
    const current = new Date(date.getFullYear(), date.getMonth(), date.getDate() + i);
    keys.push(toDateKey(current));
  }
  return keys;
}

async function requireStarosta(req, res) {
  const student = await query(
    'SELECT user_id, curator_id, is_starosta FROM students WHERE user_id = $1 LIMIT 1',
    [req.user.id],
  );
  if (student.rowCount === 0 || !student.rows[0].is_starosta) {
    return { error: res.status(403).json({ message: 'Starosta ruxsat yoq' }) };
  }
  return { student: student.rows[0] };
}

router.get('/week', requireAuth, async (req, res) => {
  const anchor = parseDateKey(req.query.date) || new Date();
  const weekKeys = weekDateKeys(anchor);

  if (req.user.role === 'student') {
    const studentRes = await query(
      'SELECT user_id, curator_id, is_starosta FROM students WHERE user_id = $1 LIMIT 1',
      [req.user.id],
    );
    if (studentRes.rowCount === 0) {
      return res.status(404).json({ message: 'Student topilmadi' });
    }
    const student = studentRes.rows[0];

    if (!student.is_starosta) {
      const records = await query(
        `SELECT date_key, present, starosta_id
         FROM attendances
         WHERE student_id = $1 AND date_key = ANY($2::text[])`,
        [req.user.id, weekKeys],
      );

      const attendance = {};
      records.rows.forEach((record) => {
        attendance[record.date_key] = {
          present: !!record.present,
          starosta_id: record.starosta_id,
        };
      });

      return res.json({ week: weekKeys, attendance });
    }

    const students = await query(
      `SELECT user_id, full_name
       FROM students
       WHERE curator_id = $1`,
      [student.curator_id],
    );
    const studentIds = students.rows.map((item) => item.user_id);

    const records = await query(
      `SELECT student_id, date_key, present, starosta_id
       FROM attendances
       WHERE curator_id = $1 AND date_key = ANY($2::text[]) AND student_id = ANY($3::text[])`,
      [student.curator_id, weekKeys, studentIds],
    );

    const starostaIds = Array.from(new Set(records.rows.map((r) => r.starosta_id).filter(Boolean)));
    let starostaNameMap = new Map();
    if (starostaIds.length > 0) {
      const starostas = await query(
        'SELECT user_id, full_name FROM students WHERE user_id = ANY($1::text[])',
        [starostaIds],
      );
      starostaNameMap = new Map(starostas.rows.map((item) => [item.user_id, item.full_name]));
    }

    const recordMap = new Map();
    records.rows.forEach((record) => {
      recordMap.set(`${record.student_id}-${record.date_key}`, record);
    });

    const payload = students.rows.map((item) => {
      const row = { id: item.user_id, full_name: item.full_name, attendance: {} };
      weekKeys.forEach((key) => {
        const record = recordMap.get(`${item.user_id}-${key}`);
        if (record) {
          row.attendance[key] = {
            present: !!record.present,
            starosta_id: record.starosta_id,
            starosta_name: starostaNameMap.get(record.starosta_id) || null,
          };
        }
      });
      return row;
    });

    return res.json({ week: weekKeys, curator_id: student.curator_id, students: payload });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const students = await query(
    'SELECT user_id, full_name FROM students WHERE curator_id = $1',
    [req.user.id],
  );
  const studentIds = students.rows.map((item) => item.user_id);

  const records = await query(
    `SELECT student_id, date_key, present, starosta_id
     FROM attendances
     WHERE curator_id = $1 AND date_key = ANY($2::text[]) AND student_id = ANY($3::text[])`,
    [req.user.id, weekKeys, studentIds],
  );

  const starostaIds = Array.from(new Set(records.rows.map((r) => r.starosta_id).filter(Boolean)));
  let starostaNameMap = new Map();
  if (starostaIds.length > 0) {
    const starostas = await query(
      'SELECT user_id, full_name FROM students WHERE user_id = ANY($1::text[])',
      [starostaIds],
    );
    starostaNameMap = new Map(starostas.rows.map((item) => [item.user_id, item.full_name]));
  }

  const recordMap = new Map();
  records.rows.forEach((record) => {
    recordMap.set(`${record.student_id}-${record.date_key}`, record);
  });

  const payload = students.rows.map((item) => {
    const row = { id: item.user_id, full_name: item.full_name, attendance: {} };
    weekKeys.forEach((key) => {
      const record = recordMap.get(`${item.user_id}-${key}`);
      if (record) {
        row.attendance[key] = {
          present: !!record.present,
          starosta_id: record.starosta_id,
          starosta_name: starostaNameMap.get(record.starosta_id) || null,
        };
      }
    });
    return row;
  });

  return res.json({ week: weekKeys, curator_id: req.user.id, students: payload });
});

router.post('/mark', requireAuth, requireRole(['student']), async (req, res) => {
  const { date, entries } = req.body || {};
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ message: 'Davomat ma`lumotlari kerak' });
  }

  const { student, error } = await requireStarosta(req, res);
  if (error) return error;

  const targetDate = parseDateKey(date) || new Date();
  const targetKey = toDateKey(targetDate);
  const todayKey = toDateKey(new Date());
  if (targetKey !== todayKey) {
    return res.status(400).json({ message: 'Davomat faqat bugun uchun' });
  }

  const studentsRes = await query(
    'SELECT user_id FROM students WHERE curator_id = $1',
    [student.curator_id],
  );
  const allowedIds = new Set(studentsRes.rows.map((item) => item.user_id));

  let applied = 0;
  for (const entry of entries) {
    const studentId = entry?.studentId?.toString();
    if (!studentId || !allowedIds.has(studentId)) {
      continue;
    }

    await query(
      `INSERT INTO attendances (
        id, curator_id, starosta_id, student_id, date_key, present, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        curator_id = VALUES(curator_id),
        starosta_id = VALUES(starosta_id),
        present = VALUES(present),
        updated_at = NOW()`,
      [createId(), student.curator_id, req.user.id, studentId, targetKey, !!entry.present],
    );
    applied += 1;
  }

  if (applied === 0) {
    return res.status(400).json({ message: 'Talabalar topilmadi' });
  }

  return res.json({ message: 'Davomat saqlandi' });
});

module.exports = router;
