require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'kwankwasiyya-secret-2025';

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/')
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname))
  }
});
const upload = multer({ storage: storage });

let NIGERIA = {};

function fetchNigeriaData() {
  return new Promise((resolve, reject) => {
    https.get('https://raw.githubusercontent.com/afeibukun/nigerian-state-lgas-wards-polling-units/main/states-and-lgas-and-wards-and-polling-units.json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const result = {};
          function titleCase(s) {
            return s.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
          }
          raw.forEach(stateObj => {
            const stateName = titleCase(stateObj.state);
            result[stateName] = {};
            stateObj.lgas.forEach(lgaObj => {
              const lgaName = titleCase(lgaObj.lga);
              result[stateName][lgaName] = lgaObj.wards.map(w => titleCase(w.ward));
            });
          });
          NIGERIA = result;
          console.log('Nigeria data loaded: ' + Object.keys(NIGERIA).length + ' states');
          resolve();
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(200) NOT NULL,
      phone VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(200),
      state VARCHAR(100) NOT NULL,
      lga VARCHAR(100) NOT NULL,
      ward VARCHAR(100) NOT NULL,
      pvc VARCHAR(100) UNIQUE NOT NULL,
      referral_code VARCHAR(20) UNIQUE NOT NULL,
      referred_by VARCHAR(20),
      password_hash VARCHAR(200) NOT NULL,
      level INT DEFAULT 1,
      kpower INT DEFAULT 0,
      profile_image VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Ensure these columns exist even if the table was created previously without them
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS profile_image VARCHAR(255);`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS level INT DEFAULT 1;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS kpower INT DEFAULT 0;`);

  // Ensure uploads directory exists
  const fs = require('fs');
  const dir = './public/uploads';
  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
  }
  console.log('Database ready');
}

function generateCode(name) {
  const prefix = name.replace(/\s+/g,'').substring(0,4).toUpperCase();
  return prefix + Math.floor(1000 + Math.random() * 9000);
}

function getLevel(refs) {
  if (refs >= 2000) return {level:10,name:'Legend'};
  if (refs >= 1200) return {level:9,name:'Champion'};
  if (refs >= 800)  return {level:8,name:'Leader'};
  if (refs >= 550)  return {level:7,name:'Strategist'};
  if (refs >= 350)  return {level:6,name:'Coordinator'};
  if (refs >= 200)  return {level:5,name:'Influencer'};
  if (refs >= 75)   return {level:4,name:'Mobilizer'};
  if (refs >= 30)   return {level:3,name:'Builder'};
  if (refs >= 10)   return {level:2,name:'Beginner'};
  return {level:1,name:'Infant'};
}

app.get('/api/states', (req, res) => res.json(Object.keys(NIGERIA).sort()));

app.get('/api/lgas/:state', (req, res) => {
  const s = NIGERIA[req.params.state];
  if (!s) return res.status(404).json({error:'State not found'});
  res.json(Object.keys(s).sort());
});

app.get('/api/wards/:state/:lga', (req, res) => {
  const s = NIGERIA[req.params.state];
  if (!s) return res.status(404).json({error:'State not found'});
  const l = s[req.params.lga];
  if (!l) return res.status(404).json({error:'LGA not found'});
  res.json(l.slice().sort());
});

app.post('/api/register', upload.single('profile_image'), async (req, res) => {
  try {
    const {full_name,phone,email,state,lga,ward,pvc,referred_by,password} = req.body;
    const profile_image = req.file ? '/uploads/' + req.file.filename : null;
    if (!full_name||!phone||!state||!lga||!ward||!pvc||!password)
      return res.status(400).json({error:'All required fields must be filled'});
    if (password.length < 6)
      return res.status(400).json({error:'Password must be at least 6 characters'});
    const pvcUp = pvc.toUpperCase();
    if ((await pool.query('SELECT id FROM members WHERE pvc=$1',[pvcUp])).rows.length)
      return res.status(400).json({error:'This Voters Card number is already registered'});
    if ((await pool.query('SELECT id FROM members WHERE phone=$1',[phone])).rows.length)
      return res.status(400).json({error:'This phone number is already registered'});
    if (referred_by) {
      if (!(await pool.query('SELECT id FROM members WHERE referral_code=$1',[referred_by.toUpperCase()])).rows.length)
        return res.status(400).json({error:'Invalid referral code'});
    }
    const password_hash = await bcrypt.hash(password, 10);
    let referral_code = generateCode(full_name);
    while ((await pool.query('SELECT id FROM members WHERE referral_code=$1',[referral_code])).rows.length)
      referral_code = generateCode(full_name);
    const r = await pool.query(
      'INSERT INTO members (full_name,phone,email,state,lga,ward,pvc,referral_code,referred_by,password_hash,profile_image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,full_name,referral_code,state,lga,ward,profile_image',
      [full_name,phone,email||null,state,lga,ward,pvcUp,referral_code,referred_by?referred_by.toUpperCase():null,password_hash,profile_image]
    );
    if (referred_by)
      await pool.query('UPDATE members SET kpower=kpower+50 WHERE referral_code=$1',[referred_by.toUpperCase()]);
    const m = r.rows[0];
    const token = jwt.sign({id:m.id,referral_code:m.referral_code}, JWT_SECRET, {expiresIn:'30d'});
    res.json({success:true,token,member:{id:m.id,full_name:m.full_name,referral_code:m.referral_code,level:1,level_name:'Infant',kpower:0,state:m.state,lga:m.lga,ward:m.ward,referrals:0,rank_state:1,rank_national:1,profile_image:m.profile_image}});
  } catch(e) {
    console.error('Register error:', e);
    res.status(500).json({error:'Registration failed. Please try again.'});
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const {phone,password} = req.body;
    if (!phone||!password) return res.status(400).json({error:'Phone and password required'});
    const r = await pool.query('SELECT * FROM members WHERE phone=$1',[phone]);
    if (!r.rows.length) return res.status(401).json({error:'Invalid phone or password'});
    const m = r.rows[0];
    if (!await bcrypt.compare(password, m.password_hash))
      return res.status(401).json({error:'Invalid phone or password'});
    const refs = parseInt((await pool.query('SELECT COUNT(*) FROM members WHERE referred_by=$1',[m.referral_code])).rows[0].count);
    const lvl = getLevel(refs);
    const token = jwt.sign({id:m.id,referral_code:m.referral_code}, JWT_SECRET, {expiresIn:'30d'});
    const stateRank = parseInt((await pool.query('SELECT COUNT(*)+1 as r FROM members m2 WHERE m2.state=$1 AND (SELECT COUNT(*) FROM members WHERE referred_by=m2.referral_code)>(SELECT COUNT(*) FROM members WHERE referred_by=$2) AND m2.id!=$3',[m.state,m.referral_code,m.id])).rows[0].r);
    const natRank = parseInt((await pool.query('SELECT COUNT(*)+1 as r FROM members m2 WHERE (SELECT COUNT(*) FROM members WHERE referred_by=m2.referral_code)>(SELECT COUNT(*) FROM members WHERE referred_by=$1) AND m2.id!=$2',[m.referral_code,m.id])).rows[0].r);
    res.json({success:true,token,member:{id:m.id,full_name:m.full_name,phone:m.phone,referral_code:m.referral_code,level:lvl.level,level_name:lvl.name,kpower:m.kpower,state:m.state,lga:m.lga,ward:m.ward,referrals:refs,rank_state:stateRank,rank_national:natRank,profile_image:m.profile_image}});
  } catch(e) { res.status(500).json({error:'Login failed.'}); }
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM members WHERE id=$1',[req.user.id]);
    if (!r.rows.length) return res.status(404).json({error:'Not found'});
    const m = r.rows[0];
    const refs = parseInt((await pool.query('SELECT COUNT(*) FROM members WHERE referred_by=$1',[m.referral_code])).rows[0].count);
    const lvl = getLevel(refs);
    const thresholds = [0,10,30,75,200,350,550,800,1200,2000,9999];
    const curT = thresholds[lvl.level-1];
    const nextT = thresholds[lvl.level];
    const stateRank = parseInt((await pool.query('SELECT COUNT(*)+1 as r FROM members m2 WHERE m2.state=$1 AND (SELECT COUNT(*) FROM members WHERE referred_by=m2.referral_code)>(SELECT COUNT(*) FROM members WHERE referred_by=$2) AND m2.id!=$3',[m.state,m.referral_code,m.id])).rows[0].r);
    const natRank = parseInt((await pool.query('SELECT COUNT(*)+1 as r FROM members m2 WHERE (SELECT COUNT(*) FROM members WHERE referred_by=m2.referral_code)>(SELECT COUNT(*) FROM members WHERE referred_by=$1) AND m2.id!=$2',[m.referral_code,m.id])).rows[0].r);
    const activity = (await pool.query('SELECT full_name,created_at FROM members WHERE referred_by=$1 ORDER BY created_at DESC LIMIT 5',[m.referral_code])).rows;
    const lvlNames = ['','Infant','Beginner','Builder','Mobilizer','Influencer','Coordinator','Strategist','Leader','Champion','Legend'];
    res.json({member:{full_name:m.full_name,referral_code:m.referral_code,state:m.state,lga:m.lga,ward:m.ward,level:lvl.level,level_name:lvl.name,kpower:m.kpower+(refs*50),referrals:refs,state_rank:stateRank,national_rank:natRank,progress_current:refs-curT,progress_total:nextT-curT,next_level_name:lvlNames[lvl.level+1]||'Legend',profile_image:m.profile_image},activity:activity.map(a=>({name:a.full_name,time:a.created_at}))});
  } catch(e) { res.status(500).json({error:'Dashboard failed.'}); }
});

app.post('/api/profile-photo', auth, upload.single('profile_image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({error: 'No image uploaded'});
    const profile_image = '/uploads/' + req.file.filename;
    await pool.query('UPDATE members SET profile_image=$1 WHERE id=$2', [profile_image, req.user.id]);
    res.json({success: true, profile_image});
  } catch(e) {
    res.status(500).json({error: 'Failed to update profile image'});
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const {state, lga, ward} = req.query;
    let where = [];
    let params = [];
    if (state) { params.push(state); where.push(`m.state=$${params.length}`); }
    if (lga) { params.push(lga); where.push(`m.lga=$${params.length}`); }
    if (ward) { params.push(ward); where.push(`m.ward=$${params.length}`); }
    
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '';
    const q = 'SELECT m.full_name,m.state,m.lga,m.kpower,m.level,COUNT(r.id) as referrals FROM members m LEFT JOIN members r ON r.referred_by=m.referral_code ' + whereStr + 'GROUP BY m.id ORDER BY referrals DESC LIMIT 20';
    
    const result = await pool.query(q, params);
    const rows = result.rows.map(row => {
      const refs = parseInt(row.referrals);
      const lvl = getLevel(refs);
      return {
        full_name: row.full_name,
        state: row.state,
        lga: row.lga,
        referrals: refs,
        level: lvl.level,
        level_name: lvl.name,
        kpower: row.kpower + (refs * 50)
      };
    });
    res.json(rows);
  } catch(e) { res.status(500).json({error:'Leaderboard failed.'}); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const total = parseInt((await pool.query('SELECT COUNT(*) FROM members')).rows[0].count);
    const states = parseInt((await pool.query('SELECT COUNT(DISTINCT state) FROM members')).rows[0].count);
    res.json({total_members:total,states_covered:states});
  } catch(e) { res.json({total_members:0,states_covered:0}); }
});

function auth(req, res, next) {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({error:'Auth required'});
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({error:'Invalid token'});
    req.user = user; next();
  });
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

async function start() {
  await fetchNigeriaData();
  await initDB();
  app.listen(PORT, () => console.log('Kwankwasiyya Vault running on port ' + PORT));
}
start();
