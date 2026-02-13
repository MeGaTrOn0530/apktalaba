const express = require('express');

const { requireAuth, requireRole } = require('../middleware/auth');
const { query, createId } = require('../db');
const { isId } = require('../utils/sql');

const router = express.Router();
const TASK_CATEGORIES = [
  "Ma'naviyat va milliy qadriyatlar",
  "Axloqiy me'yorlar va kasbiy etika",
  "Mahalla, oila va jamiyatdagi mas'uliyat",
  "Raqamli madaniyat va axborot xavfsizligi",
  "Yoshlar va barkamol shaxs tarbiyasi",
];

router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'student') {
    const tasksRes = await query('SELECT * FROM tasks ORDER BY created_at DESC');
    const assignmentsRes = await query(
      'SELECT * FROM task_assignments WHERE student_id = $1',
      [req.user.id],
    );
    const assignmentMap = new Map(assignmentsRes.rows.map((row) => [row.task_id, row]));
    return res.json(
      tasksRes.rows.map((task) => {
        const assignment = assignmentMap.get(task.id);
        return {
          ...task,
          assignment_status: assignment?.status ?? null,
          graded_score: assignment?.graded_score ?? null,
          feedback: assignment?.feedback ?? null,
          assignment_id: assignment?.id ?? null,
        };
      }),
    );
  }

  if (req.user.role === 'admin') {
    const result = await query(
      'SELECT * FROM tasks WHERE curator_id = $1 ORDER BY created_at DESC',
      [req.user.id],
    );
    return res.json(result.rows);
  }

  const result = await query('SELECT * FROM tasks ORDER BY created_at DESC');
  return res.json(result.rows);
});

router.post('/', requireAuth, requireRole(['admin']), async (req, res) => {
  const { title, description, type, deadlineAt, attachmentUrl, category } = req.body || {};
  if (!title) {
    return res.status(400).json({ message: 'Sarlavha kerak' });
  }
  if (!category || !TASK_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: "Bo'lim tanlash kerak" });
  }

  const id = createId();
  const result = await query(
    `INSERT INTO tasks (
      id, curator_id, title, description, type, attachment_url, category, deadline_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`,
    [id, req.user.id, title, description ?? null, type ?? null, attachmentUrl ?? null, category, deadlineAt ?? null],
  );

  return res.status(201).json(result.rows[0]);
});

router.patch('/:id', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  const taskId = req.params.id;
  if (!isId(taskId)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const taskRes = await query('SELECT id, curator_id FROM tasks WHERE id = $1 LIMIT 1', [taskId]);
  if (taskRes.rowCount === 0) {
    return res.status(404).json({ message: 'Topshiriq topilmadi' });
  }
  if (req.user.role === 'admin' && taskRes.rows[0].curator_id !== req.user.id) {
    return res.status(403).json({ message: 'Ruxsat yoq' });
  }

  const { title, description, type, deadlineAt, attachmentUrl, category, status } = req.body || {};
  if (category !== undefined && !TASK_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: "Bo'lim tanlash kerak" });
  }

  await query(
    `UPDATE tasks
     SET title = COALESCE($2, title),
         description = COALESCE($3, description),
         type = COALESCE($4, type),
         deadline_at = COALESCE($5, deadline_at),
         attachment_url = COALESCE($6, attachment_url),
         category = COALESCE($7, category),
         status = COALESCE($8, status)
     WHERE id = $1`,
    [taskId, title ?? null, description ?? null, type ?? null, deadlineAt ?? null, attachmentUrl ?? null, category ?? null, status ?? null],
  );

  return res.json({ message: 'Topshiriq yangilandi' });
});

router.delete('/:id', requireAuth, requireRole(['admin', 'super']), async (req, res) => {
  const taskId = req.params.id;
  if (!isId(taskId)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const taskRes = await query('SELECT id, curator_id FROM tasks WHERE id = $1 LIMIT 1', [taskId]);
  if (taskRes.rowCount === 0) {
    return res.status(404).json({ message: 'Topshiriq topilmadi' });
  }
  if (req.user.role === 'admin' && taskRes.rows[0].curator_id !== req.user.id) {
    return res.status(403).json({ message: 'Ruxsat yoq' });
  }

  await query('DELETE FROM tasks WHERE id = $1', [taskId]);
  return res.json({ message: 'Topshiriq ochirildi' });
});

router.get('/:id/submissions', requireAuth, requireRole(['admin']), async (req, res) => {
  const taskId = req.params.id;
  if (!isId(taskId)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  const taskRes = await query('SELECT id, curator_id FROM tasks WHERE id = $1 AND curator_id = $2 LIMIT 1', [taskId, req.user.id]);
  if (taskRes.rowCount === 0) {
    return res.status(404).json({ message: 'Topshiriq topilmadi' });
  }

  const studentsRes = await query(
    `SELECT user_id, full_name
     FROM students
     WHERE curator_id = $1`,
    [req.user.id],
  );
  const assignmentsRes = await query(
    `SELECT *
     FROM task_assignments
     WHERE task_id = $1
     ORDER BY updated_at DESC`,
    [taskId],
  );
  const assignmentIds = assignmentsRes.rows.map((row) => row.id);

  let submissionsRows = [];
  if (assignmentIds.length > 0) {
    const submissionsRes = await query(
      `SELECT ts.assignment_id, ts.file_url, ts.text, ts.submitted_at
       FROM task_submissions ts
       INNER JOIN (
         SELECT assignment_id, MAX(submitted_at) AS latest_submitted_at
         FROM task_submissions
         WHERE assignment_id = ANY($1::text[])
         GROUP BY assignment_id
       ) latest ON latest.assignment_id = ts.assignment_id
              AND latest.latest_submitted_at = ts.submitted_at`,
      [assignmentIds],
    );
    submissionsRows = submissionsRes.rows;
  }

  const submissionMap = new Map(submissionsRows.map((row) => [row.assignment_id, row]));
  const assignmentMap = new Map(assignmentsRes.rows.map((row) => [row.student_id, row]));

  return res.json(
    studentsRes.rows.map((student) => {
      const assignment = assignmentMap.get(student.user_id);
      const submission = assignment ? submissionMap.get(assignment.id) : null;
      return {
        assignment_id: assignment?.id ?? null,
        student_id: student.user_id,
        student_name: student.full_name ?? 'Student',
        status: assignment?.status ?? 'not_submitted',
        graded_score: assignment?.graded_score ?? null,
        feedback: assignment?.feedback ?? null,
        submission: submission
          ? {
              file_url: submission.file_url ?? null,
              text: submission.text ?? null,
              submitted_at: submission.submitted_at ?? null,
            }
          : null,
      };
    }),
  );
});

router.post('/:id/assign', requireAuth, requireRole(['admin']), async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) {
    return res.status(400).json({ message: 'Student kerak' });
  }
  if (!isId(req.params.id) || !isId(studentId)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  await query(
    `INSERT INTO task_assignments (id, task_id, student_id)
     VALUES ($1, $2, $3)
     ON DUPLICATE KEY UPDATE id = id`,
    [createId(), req.params.id, studentId],
  );
  return res.json({ message: 'Topshiriq biriktirildi' });
});

router.post('/:id/submissions', requireAuth, requireRole(['student']), async (req, res) => {
  const { text, fileUrl } = req.body || {};
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  let assignmentRes = await query(
    `SELECT id FROM task_assignments
     WHERE task_id = $1 AND student_id = $2
     LIMIT 1`,
    [req.params.id, req.user.id],
  );

  let assignmentId;
  if (assignmentRes.rowCount === 0) {
    assignmentId = createId();
    await query(
      `INSERT INTO task_assignments (id, task_id, student_id)
       VALUES ($1, $2, $3)`,
      [assignmentId, req.params.id, req.user.id],
    );
  } else {
    assignmentId = assignmentRes.rows[0].id;
  }

  await query(
    `INSERT INTO task_submissions (id, assignment_id, file_url, text)
     VALUES ($1, $2, $3, $4)`,
    [createId(), assignmentId, fileUrl ?? null, text ?? null],
  );

  await query(
    `UPDATE task_assignments
     SET status = 'under_review', updated_at = NOW()
     WHERE id = $1`,
    [assignmentId],
  );

  return res.json({ message: 'Yuborildi' });
});

router.patch('/assignments/:id/status', requireAuth, requireRole(['admin']), async (req, res) => {
  const { status, gradedScore, feedback } = req.body || {};
  if (!isId(req.params.id)) {
    return res.status(400).json({ message: 'Notogri ID' });
  }

  await query(
    `UPDATE task_assignments
     SET status = COALESCE($2, status),
         graded_score = COALESCE($3, graded_score),
         feedback = COALESCE($4, feedback),
         updated_at = NOW()
     WHERE id = $1`,
    [req.params.id, status ?? null, gradedScore ?? null, feedback ?? null],
  );

  return res.json({ message: 'Holat yangilandi' });
});

module.exports = router;
