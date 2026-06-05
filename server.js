require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'kwankwasiyya-secret-2025';

// Nigeria geo data
const NIGERIA = require('./nigeria_data.json');

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(200) NOT NULL,
      phone VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(200) UNIQUE,
      state VARCHAR(100) NOT NULL,
      lga VARCHAR(100) NOT NULL,
      ward VARCHAR(100) NOT NULL,
      pvc VARCHAR(100) UNIQUE NOT NULL,
      referral_code VARCHAR(20) UNIQUE NOT NULL,
      referred_by VARCHAR(20),
      password_hash VARCHAR(200) NOT NULL,
      level INT DEFAULT 1,
      kpower INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database ready');
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function generateCode(name) {
  const prefix = name.replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const num = Math.floor(1000 + Math.random() * 9000);
  return prefix + num;
}

function getLevel(referrals) {
  if (referrals >= 2000) return { level: 10, name: 'Legend' };
  if (referrals >= 1200) return { level: 9, name: 'Champion' };
  if (referrals >= 800)  return { level: 8, name: 'Leader' };
  if (referrals >= 550)  return { level: 7, name: 'Strategist' };
  if (referrals >= 350)  return { level: 6, name: 'Coordinator' };
  if (referrals >= 200)  return { level: 5, name: 'Influencer' };
  if (referrals >= 75)   return { level: 4, name: 'Mobilizer' };
  if (referrals >= 30)   return { level: 3, name: 'Builder' };
  if (referrals >= 10)   return { level: 2, name: 'Beginner' };
  return { level: 1, name: 'Infant' };
}

// ── GEO API ──────────────────────────────────────────────────────────────────
app.get('/api/states', (req, res) => {
  res.json(Object.keys(NIGERIA).sort());
});

app.get('/api/lgas/:state', (req, res) => {
  const state = req.params.state;
  if (!NIGERIA[state]) return res.status(404).json({ error: 'State not found' });
  res.json(Object.keys(NIGERIA[state]).sort());
});

app.get('/api/wards/:state/:lga', (req, res) => {
  const { state, lga } = req.params;
  if (!NIGERIA[state]) return res.status(404).json({ error: 'State not found' });
  if (!NIGERIA[state][lga]) return res.status(404).json({ error: 'LGA not found' });
  res.json(NIGERIA[state][lga].slice().sort());
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { full_name, phone, email, state, lga, ward, pvc, referred_by, password } = req.body;

    // Validate required fields
    if (!full_name || !phone || !state || !lga || !ward || !pvc || !password) {
      return res.status(400).json({ error: 'All required fields must be filled' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check for duplicate PVC
    const pvcCheck = await pool.query('SELECT id FROM members WHERE pvc = $1', [pvc.toUpperCase()]);
    if (pvcCheck.rows.length > 0) {
      return res.status(400).json({ error: 'This Voters Card number is already registered' });
    }

    // Check for duplicate phone
    const phoneCheck = await pool.query('SELECT id FROM members WHERE phone = $1', [phone]);
    if (phoneCheck.rows.length > 0) {
      return res.status(400).json({ error: 'This phone number is already registered' });
    }

    // Validate referral code if provided
    if (referred_by) {
      const refCheck = await pool.query('SELECT id FROM members WHERE referral_code = $1', [referred_by.toUpperCase()]);
      if (refCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
    }

    const password_hash = await bcrypt.hash(password, 10);
    let referral_code = generateCode(full_name);

    // Ensure unique referral code
    let codeExists = true;
    while (codeExists) {
      const check = await pool.query('SELECT id FROM members WHERE referral_code = $1', [referral_code]);
      if (check.rows.length === 0) codeExists = false;
      else referral_code = generateCode(full_name);
    }

    const result = await pool.query(
      `INSERT INTO members (full_name, phone, email, state, lga, ward, pvc, referral_code, referred_by, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, full_name, referral_code, level, kpower, state, lga, ward`,
      [full_name, phone, email || null, state, lga, ward, pvc.toUpperCase(), referral_code, referred_by?.toUpperCase() || null, password_hash]
    );

    // Award K-Power to referrer
    if (referred_by) {
      await pool.query(
        `UPDATE members SET kpower = kpower + 50 WHERE referral_code = $1`,
        [referred_by.toUpperCase()]
      );
    }

    const member = result.rows[0];
    const token = jwt.sign({ id: member.id, referral_code: member.referral_code }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      member: {
        id: member.id,
        full_name: member.full_name,
        referral_code: member.referral_code,
        level: member.level,
        level_name: 'Infant',
        kpower: member.kpower,
        state: member.state,
        lga: member.lga,
        ward: member.ward
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

    const result = await pool.query('SELECT * FROM members WHERE phone = $1', [phone]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid phone or password' });

    const member = result.rows[0];
    const valid = await bcrypt.compare(password, member.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid phone or password' });

    // Count referrals
    const refCount = await pool.query('SELECT COUNT(*) FROM members WHERE referred_by = $1', [member.referral_code]);
    const referrals = parseInt(refCount.rows[0].count);
    const levelInfo = getLevel(referrals);

    const token = jwt.sign({ id: member.id, referral_code: member.referral_code }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      member: {
        id: member.id,
        full_name: member.full_name,
        phone: member.phone,
        email: member.email,
        referral_code: member.referral_code,
        level: levelInfo.level,
        level_name: levelInfo.name,
        kpower: member.kpower,
        state: member.state,
        lga: member.lga,
        ward: member.ward,
        referrals,
        created_at: member.created_at
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const member = await pool.query('SELECT * FROM members WHERE id = $1', [req.user.id]);
    if (member.rows.length === 0) return res.status(404).json({ error: 'Member not found' });

    const m = member.rows[0];
    const refResult = await pool.query('SELECT COUNT(*) FROM members WHERE referred_by = $1', [m.referral_code]);
    const referrals = parseInt(refResult.rows[0].count);
    const levelInfo = getLevel(referrals);

    // State rank
    const stateRank = await pool.query(
      `SELECT COUNT(*) + 1 as rank FROM members m2
       WHERE m2.state = $1
       AND (SELECT COUNT(*) FROM members WHERE referred_by = m2.referral_code) >
           (SELECT COUNT(*) FROM members WHERE referred_by = $2)
       AND m2.id != $3`,
      [m.state, m.referral_code, m.id]
    );

    // National rank
    const nationalRank = await pool.query(
      `SELECT COUNT(*) + 1 as rank FROM members m2
       WHERE (SELECT COUNT(*) FROM members WHERE referred_by = m2.referral_code) >
             (SELECT COUNT(*) FROM members WHERE referred_by = $1)
       AND m2.id != $2`,
      [m.referral_code, m.id]
    );

    // Recent referrals (activity)
    const activity = await pool.query(
      `SELECT full_name, created_at FROM members WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 5`,
      [m.referral_code]
    );

    // Next level info
    const levelThresholds = [0, 10, 30, 75, 200, 350, 550, 800, 1200, 2000];
    const nextThreshold = levelThresholds[levelInfo.level] || 2000;
    const currentThreshold = levelThresholds[levelInfo.level - 1] || 0;

    res.json({
      member: {
        full_name: m.full_name,
        referral_code: m.referral_code,
        state: m.state,
        lga: m.lga,
        ward: m.ward,
        level: levelInfo.level,
        level_name: levelInfo.name,
        kpower: m.kpower + (referrals * 50),
        referrals,
        state_rank: parseInt(stateRank.rows[0].rank),
        national_rank: parseInt(nationalRank.rows[0].rank),
        progress_current: referrals - currentThreshold,
        progress_total: nextThreshold - currentThreshold,
        next_level_name: levelInfo.level < 10 ? ['','Infant','Beginner','Builder','Mobilizer','Influencer','Coordinator','Strategist','Leader','Champion','Legend'][levelInfo.level + 1] : 'Legend'
      },
      activity: activity.rows.map(a => ({
        name: a.full_name,
        time: a.created_at
      }))
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── LEADERBOARD ────────────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { state } = req.query;
    let query = `
      SELECT m.full_name, m.state, m.lga,
             COUNT(r.id) as referrals
      FROM members m
      LEFT JOIN members r ON r.referred_by = m.referral_code
      ${state ? 'WHERE m.state = $1' : ''}
      GROUP BY m.id, m.full_name, m.state, m.lga
      ORDER BY referrals DESC
      LIMIT 20
    `;
    const result = state
      ? await pool.query(query, [state])
      : await pool.query(query);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ── STATS ──────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM members');
    const states = await pool.query('SELECT COUNT(DISTINCT state) FROM members');
    res.json({
      total_members: parseInt(total.rows[0].count),
      states_covered: parseInt(states.rows[0].count)
    });
  } catch (err) {
    res.json({ total_members: 0, states_covered: 0 });
  }
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ── SERVE FRONTEND ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Kwankwasiyya Vault running on port ${PORT}`));
});
