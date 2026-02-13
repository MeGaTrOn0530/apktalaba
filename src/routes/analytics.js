const express = require('express');

const { requireAuth, requireRole } = require('../middleware/auth');
const { query } = require('../db');

const router = express.Router();
const MONTH_LABELS = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyun', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];

function getMonthKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}`;
}

function buildMonthlySeries(countMap, startDate, months) {
  const labels = [];
  const values = [];
  for (let i = 0; i < months; i += 1) {
    const date = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    labels.push(MONTH_LABELS[date.getMonth()]);
    values.push(countMap.get(getMonthKey(date)) || 0);
  }
  return { labels, values };
}

async function fetchMonthlyCounts(table, field, startDate, endDate, extraWhere = '', params = []) {
  const result = await query(
    `SELECT
       EXTRACT(YEAR FROM ${field})::int AS year,
       EXTRACT(MONTH FROM ${field})::int AS month,
       COUNT(*)::int AS count
     FROM ${table}
     WHERE ${field} BETWEEN $1 AND $2
     ${extraWhere}
     GROUP BY year, month`,
    [startDate, endDate, ...params],
  );

  const map = new Map();
  result.rows.forEach((row) => {
    map.set(`${row.year}-${row.month}`, row.count);
  });
  return map;
}

router.get('/super', requireAuth, requireRole(['super']), async (_req, res) => {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const [
    totalStudentsRes,
    activeStudentsRes,
    totalAdminsRes,
    activeAdminsRes,
    totalNewsRes,
    totalEventsRes,
    totalTasksRes,
    gradedCountRes,
    totalNotificationsRes,
    studentCounts,
    newsCounts,
    eventCounts,
    taskCounts,
  ] = await Promise.all([
    query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'student'`),
    query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'student' AND status = 'active'`),
    query(`SELECT COUNT(*)::int AS count FROM users WHERE role IN ('admin', 'super')`),
    query(`SELECT COUNT(*)::int AS count FROM users WHERE role IN ('admin', 'super') AND status = 'active'`),
    query('SELECT COUNT(*)::int AS count FROM news'),
    query('SELECT COUNT(*)::int AS count FROM events'),
    query('SELECT COUNT(*)::int AS count FROM tasks'),
    query(`SELECT COUNT(*)::int AS count FROM task_assignments WHERE status = 'graded' OR graded_score IS NOT NULL`),
    query('SELECT COUNT(*)::int AS count FROM notifications'),
    fetchMonthlyCounts('users', 'created_at', startDate, endDate, `AND role = 'student'`),
    fetchMonthlyCounts('news', 'published_at', startDate, endDate),
    fetchMonthlyCounts('events', 'created_at', startDate, endDate),
    fetchMonthlyCounts('tasks', 'created_at', startDate, endDate),
  ]);

  const totalStudents = totalStudentsRes.rows[0].count;
  const activeStudents = activeStudentsRes.rows[0].count;
  const totalAdmins = totalAdminsRes.rows[0].count;
  const activeAdmins = activeAdminsRes.rows[0].count;
  const totalNews = totalNewsRes.rows[0].count;
  const totalEvents = totalEventsRes.rows[0].count;
  const totalTasks = totalTasksRes.rows[0].count;
  const gradedCount = gradedCountRes.rows[0].count;
  const totalNotifications = totalNotificationsRes.rows[0].count;

  const activityMap = new Map();
  [newsCounts, eventCounts, taskCounts].forEach((map) => {
    map.forEach((value, key) => {
      activityMap.set(key, (activityMap.get(key) || 0) + value);
    });
  });

  return res.json({
    totalStudents,
    activeStudents,
    totalAdmins,
    activeAdmins,
    totalNews,
    totalEvents,
    totalTasks,
    gradedCount,
    totalNotifications,
    activityScore: totalTasks + totalNews + totalEvents,
    activitySeries: buildMonthlySeries(activityMap, startDate, 6),
    growthSeries: buildMonthlySeries(studentCounts, startDate, 6),
  });
});

router.get('/admin', requireAuth, requireRole(['admin']), async (req, res) => {
  const [assignedStudentsRes, tasksActiveRes] = await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM students WHERE curator_id = $1', [req.user.id]),
    query('SELECT COUNT(*)::int AS count FROM tasks WHERE curator_id = $1', [req.user.id]),
  ]);
  return res.json({
    assignedStudents: assignedStudentsRes.rows[0].count,
    tasksActive: tasksActiveRes.rows[0].count,
  });
});

module.exports = router;
