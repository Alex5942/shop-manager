const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 80;

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json());

// ============ DATABASE ============
const db = new Database(path.join(__dirname, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'staff',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    sort_order INTEGER DEFAULT 0,
    UNIQUE(name, type)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    amount REAL NOT NULL CHECK(amount > 0),
    category TEXT NOT NULL,
    payment TEXT DEFAULT 'cash',
    note TEXT DEFAULT '',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_trans_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_trans_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_trans_category ON transactions(category);
`);

// Seed default users if empty
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const insert = db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)');
  insert.run('admin', process.env.ADMIN_PASSWORD || crypto.randomBytes(8).toString('hex'), '管理员', 'admin');
  insert.run('staff', process.env.STAFF_PASSWORD || crypto.randomBytes(8).toString('hex'), '店员', 'staff');
  console.log('✅ Default users created (check logs for passwords, or set ADMIN_PASSWORD/STAFF_PASSWORD env vars)');
}

// Seed default categories if empty
const catCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
if (catCount === 0) {
  const insert = db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, ?)');
  const incomeCats = ['商品销售', '服务收入', '会员充值', '外卖平台', '退款回收', '其他收入'];
  const expenseCats = ['进货成本', '房租水电', '员工工资', '物流配送', '营销推广', '设备维护', '办公耗材', '税费', '其他支出'];
  incomeCats.forEach((c, i) => insert.run(c, 'income', i));
  expenseCats.forEach((c, i) => insert.run(c, 'expense', i));
  console.log('✅ Default categories created');
}

// ============ AUTH API ============
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  // NOTE: Passwords are stored in plaintext for simplicity. For production, use bcrypt.
  const user = db.prepare('SELECT id, username, name, role FROM users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  // Simple token (not JWT, just a session identifier)
  const token = crypto.randomBytes(32).toString('hex');
  res.json({ token, user });
});

// ============ TRANSACTIONS API ============

// List transactions with filters
app.get('/api/transactions', (req, res) => {
  const { type, category, month, search, page = 1, limit = 50 } = req.query;
  let where = [];
  let params = [];

  if (type && type !== 'all') { where.push('type = ?'); params.push(type); }
  if (category && category !== 'all') { where.push('category = ?'); params.push(category); }
  if (month) { where.push('date LIKE ?'); params.push(month + '%'); }
  if (search) { where.push('(note LIKE ? OR category LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const total = db.prepare(`SELECT COUNT(*) as c FROM transactions ${whereClause}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM transactions ${whereClause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) });
});

// Get single transaction
app.get('/api/transactions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  res.json(row);
});

// Create transaction
app.post('/api/transactions', (req, res) => {
  const { date, type, amount, category, payment, note } = req.body;
  if (!date || !type || !amount || !category) return res.status(400).json({ error: '缺少必填字段' });
  if (amount <= 0) return res.status(400).json({ error: '金额必须大于0' });

  const result = db.prepare('INSERT INTO transactions (date, type, amount, category, payment, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(date, type, amount, category, payment || 'cash', note || '', req.body.created_by || '');
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// Update transaction
app.put('/api/transactions/:id', (req, res) => {
  const { date, type, amount, category, payment, note } = req.body;
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '记录不存在' });

  db.prepare('UPDATE transactions SET date=?, type=?, amount=?, category=?, payment=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
    date || existing.date, type || existing.type, amount || existing.amount,
    category || existing.category, payment || existing.payment, note ?? existing.note, req.params.id
  );
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  res.json(row);
});

// Delete transaction
app.delete('/api/transactions/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '记录不存在' });
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============ CATEGORIES API ============
app.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY type, sort_order').all();
  const result = { income: [], expense: [] };
  rows.forEach(r => result[r.type].push(r.name));
  res.json(result);
});

app.post('/api/categories', (req, res) => {
  const { income, expense } = req.body;
  const del = db.prepare('DELETE FROM categories');
  const ins = db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, ?)');
  const txn = db.transaction(() => {
    del.run();
    (income || []).forEach((c, i) => ins.run(c, 'income', i));
    (expense || []).forEach((c, i) => ins.run(c, 'expense', i));
  });
  txn();
  res.json({ success: true });
});

// ============ STATS API ============
app.get('/api/stats/summary', (req, res) => {
  const { month, from, to } = req.query;

  const whereClauses = [];
  const params = [];
  if (from) { whereClauses.push('date >= ?'); params.push(from); }
  if (to) { whereClauses.push('date <= ?'); params.push(to); }
  if (month && !from && !to) { whereClauses.push('date LIKE ?'); params.push(month + '%'); }

  const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
  const incomeWhere = [...whereClauses, "type = 'income'"].join(' AND ');
  const expenseWhere = [...whereClauses, "type = 'expense'"].join(' AND ');

  const income = db.prepare(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM transactions WHERE ${incomeWhere}`).get(...params);
  const expense = db.prepare(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM transactions WHERE ${expenseWhere}`).get(...params);

  // Today
  const today = new Date().toISOString().slice(0, 10);
  const todayWhere = [...whereClauses, 'date = ?'].join(' AND ');
  const todayParams = [...params, today];
  const todayCount = db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE ${todayWhere}`).get(...todayParams).c;

  res.json({
    income: income.total,
    incomeCount: income.count,
    expense: expense.total,
    expenseCount: expense.count,
    profit: income.total - expense.total,
    profitRate: income.total > 0 ? ((income.total - expense.total) / income.total * 100) : 0,
    total: income.count + expense.count,
    todayCount
  });
});

app.get('/api/stats/daily', (req, res) => {
  const { days = 30, from, to } = req.query;
  let dateFilter, dateParams;
  if (from && to) {
    dateFilter = 'date >= ? AND date <= ?';
    dateParams = [from, to];
  } else {
    dateFilter = 'date >= date(\'now\', ?)';
    dateParams = [`-${parseInt(days)} days`];
  }
  const rows = db.prepare(`
    SELECT date, type, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    WHERE ${dateFilter}
    GROUP BY date, type
    ORDER BY date
  `).all(...dateParams);

  const result = {};
  rows.forEach(r => {
    if (!result[r.date]) result[r.date] = { date: r.date, income: 0, expense: 0 };
    result[r.date][r.type] = r.total;
  });
  res.json(Object.values(result));
});

app.get('/api/stats/monthly', (req, res) => {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, type, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    GROUP BY month, type
    ORDER BY month
  `).all();

  const result = {};
  rows.forEach(r => {
    if (!result[r.month]) result[r.month] = { month: r.month, income: 0, expense: 0 };
    result[r.month][r.type] = r.total;
  });
  res.json(Object.values(result));
});

app.get('/api/stats/category', (req, res) => {
  const { type, from, to } = req.query;
  let conditions = [];
  let params = [];
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (from) { conditions.push('date >= ?'); params.push(from); }
  if (to) { conditions.push('date <= ?'); params.push(to); }
  let where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT category, type, SUM(amount) as total, COUNT(*) as count
    FROM transactions ${where}
    GROUP BY category, type
    ORDER BY total DESC
  `).all(...params);

  res.json(rows);
});

app.get('/api/stats/payment', (req, res) => {
  const rows = db.prepare(`
    SELECT payment, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    GROUP BY payment
    ORDER BY total DESC
  `).all();
  res.json(rows);
});

// ============ SERVE STATIC FILES ============
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to login
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Shop Manager running on http://0.0.0.0:${PORT}`);
});
