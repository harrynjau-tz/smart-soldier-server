const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');

const DB_DIR = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(DB_DIR, 'smart_soldier.db'));

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS soldiers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_number TEXT    UNIQUE NOT NULL,
    name         TEXT    NOT NULL,
    rank         TEXT    NOT NULL,
    unit         TEXT    NOT NULL,
    phone        TEXT    DEFAULT '',
    blood_group  TEXT    DEFAULT '',
    password     TEXT    NOT NULL,
    created_at   TEXT    DEFAULT (datetime('now'))
  );
`);

// Add new columns to existing databases (safe — ignored if already exist)
try { db.exec(`ALTER TABLE soldiers ADD COLUMN age   INTEGER DEFAULT 0`);  } catch {}
try { db.exec(`ALTER TABLE soldiers ADD COLUMN photo TEXT    DEFAULT ''`); } catch {}

// ── Admins table ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    full_name  TEXT DEFAULT '',
    role       TEXT DEFAULT 'admin',
    department TEXT DEFAULT '',
    phone      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Add columns to existing admin tables (safe)
try { db.exec(`ALTER TABLE admins ADD COLUMN department TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE admins ADD COLUMN phone      TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE admins ADD COLUMN photo      TEXT DEFAULT ''`); } catch {}

// Seed default admin if table is empty
const adminCount = db.prepare('SELECT COUNT(*) as c FROM admins').get().c;
if (adminCount === 0) {
  db.prepare('INSERT INTO admins (username, password, full_name, role, department, phone) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin', bcrypt.hashSync('admin1234', 10), 'HARRISON NJAU', 'superadmin', 'Makao Makuu', '');
  console.log('[DB] Seeded default admin: admin / admin1234');
}

// Update existing default admin name if still using old placeholder
db.prepare(`UPDATE admins SET full_name='HARRISON NJAU' WHERE username='admin' AND full_name='Msimamizi Mkuu'`).run();

// ── Seed default soldiers (only if table is empty) ──────────────────────────
const count = db.prepare('SELECT COUNT(*) as c FROM soldiers').get().c;
if (count === 0) {
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const insert = db.prepare(`
    INSERT INTO soldiers (badge_number, name, rank, unit, phone, blood_group, age, photo, password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const defaults = [
    ['SS001', 'Hassan Njau',    'Luteni',        'Air Defence - Tanga', '0712000001', 'O+',  28, '', 'pass001'],
    ['SS002', 'Juma Omari',     'Sajenti',        'Alpha Company',       '0712000002', 'A+',  35, '', 'pass002'],
    ['SS003', 'Amina Salehe',   'Koplo',          'Bravo Company',       '0712000003', 'B+',  24, '', 'pass003'],
    ['SS004', 'Peter Mwangi',   'Kapteni',        'HQ Unit',             '0712000004', 'AB+', 42, '', 'pass004'],
    ['SS005', 'Fatuma Rashidi', 'Askari Daraja',  'Charlie Company',     '0712000005', 'O-',  22, '', 'pass005'],
  ];

  defaults.forEach(([badge, name, rank, unit, phone, blood, age, photo, pw]) => {
    insert.run(badge, name, rank, unit, phone, blood, age, photo, hash(pw));
  });

  console.log('[DB] Seeded default soldiers');
}

// ── Queries ──────────────────────────────────────────────────────────────────
function login(badgeNumber, password) {
  const soldier = db.prepare(
    'SELECT * FROM soldiers WHERE badge_number = ?'
  ).get(badgeNumber);

  if (!soldier) return { ok: false, message: 'Badge number haijulikani' };

  const match = bcrypt.compareSync(password, soldier.password);
  if (!match) return { ok: false, message: 'Nywila si sahihi' };

  const { password: _, ...safe } = soldier;
  return { ok: true, soldier: safe };
}

function getAllSoldiers() {
  return db.prepare(
    'SELECT id, badge_number, name, rank, unit, phone, blood_group, age, photo, created_at FROM soldiers ORDER BY rank'
  ).all();
}

function addSoldier({ badgeNumber, name, rank, unit, phone, bloodGroup, age, photo, password }) {
  if (!badgeNumber || !name || !rank || !unit || !password)
    return { ok: false, message: 'Jaza sehemu zote zinazohitajika (Badge, Jina, Cheo, Kikosi, Nywila)' };
  try {
    db.prepare(`
      INSERT INTO soldiers (badge_number, name, rank, unit, phone, blood_group, age, photo, password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      badgeNumber.trim().toUpperCase(), name.trim(), rank.trim(), unit.trim(),
      phone || '', bloodGroup || '',
      parseInt(age) || 0, photo || '',
      bcrypt.hashSync(password, 10)
    );
    return { ok: true };
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed: soldiers.badge_number'))
      return { ok: false, message: `Badge "${badgeNumber}" ipo tayari — tumia namba nyingine` };
    return { ok: false, message: e.message };
  }
}

function updateSoldierPhoto(badgeNumber, photo) {
  db.prepare('UPDATE soldiers SET photo = ? WHERE badge_number = ?').run(photo, badgeNumber);
}

function updateSoldierDetails(badgeNumber, { name, rank, unit, phone, bloodGroup, age, newPassword }) {
  if (newPassword) {
    db.prepare(`
      UPDATE soldiers SET name=?, rank=?, unit=?, phone=?, blood_group=?, age=?, password=?
      WHERE badge_number=?
    `).run(name, rank, unit, phone||'', bloodGroup||'', parseInt(age)||0,
           bcrypt.hashSync(newPassword, 10), badgeNumber);
  } else {
    db.prepare(`
      UPDATE soldiers SET name=?, rank=?, unit=?, phone=?, blood_group=?, age=?
      WHERE badge_number=?
    `).run(name, rank, unit, phone||'', bloodGroup||'', parseInt(age)||0, badgeNumber);
  }
}

function deleteSoldier(badgeNumber) {
  db.prepare('DELETE FROM soldiers WHERE badge_number = ?').run(badgeNumber);
}

// ── Admin queries ─────────────────────────────────────────────────────────────
function loginAdmin(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) return { ok: false, message: 'Jina la mtumiaji halijulikani' };
  if (!bcrypt.compareSync(password, admin.password)) return { ok: false, message: 'Nywila si sahihi' };
  const { password: _, ...safe } = admin;
  return { ok: true, admin: safe };
}

function getAllAdmins() {
  return db.prepare('SELECT id, username, full_name, role, department, phone, photo, created_at FROM admins ORDER BY id').all();
}

function updateAdminPhoto(id, photo) {
  db.prepare('UPDATE admins SET photo=? WHERE id=?').run(photo, id);
}

function addAdmin({ username, password, fullName, role, department, phone }) {
  if (!username || !password)
    return { ok: false, message: 'Jaza jina la mtumiaji na nywila' };
  try {
    db.prepare('INSERT INTO admins (username, password, full_name, role, department, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username.trim().toLowerCase(), bcrypt.hashSync(password, 10), fullName || '', role || 'admin', department || '', phone || '');
    return { ok: true };
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed: admins.username'))
      return { ok: false, message: `Jina "${username}" linatumika tayari — chagua jina lingine` };
    return { ok: false, message: e.message };
  }
}

function updateAdmin(id, { username, fullName, role, department, phone, newPassword }) {
  try {
    if (newPassword) {
      db.prepare('UPDATE admins SET username=?, full_name=?, role=?, department=?, phone=?, password=? WHERE id=?')
        .run(username, fullName || '', role || 'admin', department || '', phone || '', bcrypt.hashSync(newPassword, 10), id);
    } else {
      db.prepare('UPDATE admins SET username=?, full_name=?, role=?, department=?, phone=? WHERE id=?')
        .run(username, fullName || '', role || 'admin', department || '', phone || '', id);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function deleteAdmin(id) {
  // Prevent deleting last superadmin
  const superCount = db.prepare("SELECT COUNT(*) as c FROM admins WHERE role='superadmin'").get().c;
  const target = db.prepare('SELECT role FROM admins WHERE id=?').get(id);
  if (target?.role === 'superadmin' && superCount <= 1)
    return { ok: false, message: 'Haiwezekani kufuta superadmin wa mwisho' };
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = {
  login, getAllSoldiers, addSoldier, updateSoldierPhoto, updateSoldierDetails, deleteSoldier,
  loginAdmin, getAllAdmins, addAdmin, updateAdmin, updateAdminPhoto, deleteAdmin
};
