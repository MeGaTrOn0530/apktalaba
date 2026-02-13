function isId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function rowToUser(row) {
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    avatar_url: row.avatar_url || null,
    status: row.status,
    created_at: row.created_at,
  };
}

module.exports = {
  isId,
  rowToUser,
};
