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
app.use((req,res,next) => {
  if (req.path === '/' || req.path === '/index.html') {
    const fs = require('fs');
    let page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    page = page.replace('</body>', '<script src="/redemptions.js"></script></body>');
    return res.type('html').send(page);
  }
  next();
});
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
      community VARCHAR(200),
      senatorial_district VARCHAR(150),
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
  await pool.query(`CREATE TABLE IF NOT EXISTS security_events (
    id SERIAL PRIMARY KEY, event_type VARCHAR(80) NOT NULL, ip_address VARCHAR(120),
    phone VARCHAR(30), pvc VARCHAR(100), referral_code VARCHAR(20), details TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS security_events_ip_time ON security_events(ip_address, created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS security_events_ref_time ON security_events(referral_code, created_at);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_posts (id SERIAL PRIMARY KEY,title VARCHAR(240) NOT NULL,body TEXT NOT NULL,image_url VARCHAR(255),published BOOLEAN DEFAULT TRUE,created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS community_tasks (id SERIAL PRIMARY KEY,title VARCHAR(240) NOT NULL,description TEXT NOT NULL,platform VARCHAR(30) NOT NULL,target_url TEXT NOT NULL,points INT DEFAULT 200,active BOOLEAN DEFAULT TRUE,created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS task_submissions (id SERIAL PRIMARY KEY,task_id INT REFERENCES community_tasks(id),member_id INT REFERENCES members(id),proof_url TEXT,status VARCHAR(20) DEFAULT 'pending',points_awarded INT DEFAULT 0,created_at TIMESTAMP DEFAULT NOW(),reviewed_at TIMESTAMP,UNIQUE(task_id,member_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS redemptions (id SERIAL PRIMARY KEY, member_id INT REFERENCES members(id) NOT NULL, reward_type VARCHAR(10) NOT NULL CHECK (reward_type IN ('airtime','data')), network VARCHAR(20) NOT NULL CHECK (network IN ('MTN','Airtel','Glo','9mobile')), phone VARCHAR(30) NOT NULL, amount_naira INT NOT NULL CHECK (amount_naira >= 50 AND amount_naira <= 5000), points_debited INT NOT NULL CHECK (points_debited > 0), status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Fulfilled','Rejected')), created_at TIMESTAMP DEFAULT NOW(), reviewed_at TIMESTAMP, fulfilled_at TIMESTAMP);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS redemptions_member_created ON redemptions(member_id, created_at DESC);`);

  // Ensure uploads directory exists
  const fs = require('fs');
  const dir = './public/uploads';
  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
  }
  console.log('Database ready');
}


function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0,120);
}
async function securityEvent(type, req, data={}) {
  try { await pool.query('INSERT INTO security_events (event_type,ip_address,phone,pvc,referral_code,details) VALUES ($1,$2,$3,$4,$5,$6)', [type,requestIp(req),data.phone||null,data.pvc||null,data.referral_code||null,JSON.stringify(data)]); } catch(e) { console.error('Security log error:', e.message); }
}
async function recentCount(column, value, hours) {
  const allowed = ['ip_address','phone','pvc','referral_code'];
  if (!allowed.includes(column) || !value) return 0;
  const r = await pool.query(`SELECT COUNT(*)::int AS count FROM security_events WHERE ${column}=$1 AND created_at > NOW() - ($2 * INTERVAL '1 hour')`, [value,hours]);
  return r.rows[0].count;
}

function generateCode(name) {
  const prefix = name.replace(/\s+/g,'').substring(0,4).toUpperCase();
  return prefix + Math.floor(1000 + Math.random() * 9000);
}

function getLevel(refs) {
  if (refs >= 160) return {level:10,name:'National Ambassador'};
  if (refs >= 140) return {level:9,name:'National Champion'};
  if (refs >= 120) return {level:8,name:'State Leader'};
  if (refs >= 100) return {level:7,name:'Senatorial Strategist'};
  if (refs >= 80) return {level:6,name:'LGA Leader'};
  if (refs >= 60) return {level:5,name:'LGA Organizer'};
  if (refs >= 40) return {level:4,name:'Ward Coordinator'};
  if (refs >= 20) return {level:3,name:'Ward Mobilizer'};
  if (refs >= 10) return {level:2,name:'Community Builder'};
  return {level:1,name:'Community Member'};
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
    const {full_name,phone,email,state,lga,ward,community,senatorial_district,pvc,referred_by,password} = req.body;
    const profile_image = req.file ? '/uploads/' + req.file.filename : null;
    if (!full_name||!phone||!state||!lga||!ward||!community||!pvc||!password)
      return res.status(400).json({error:'All required fields must be filled'});
    if (password.length < 6)
      return res.status(400).json({error:'Password must be at least 6 characters'});
    const ip = requestIp(req);
    const pvcUp = String(pvc).trim().toUpperCase();
    const phoneNorm = String(phone).trim();
    const refCode = referred_by ? String(referred_by).trim().toUpperCase() : null;
    const suspiciousSignals = [];
    if (await recentCount('ip_address', ip, 1) >= 10) {
      await securityEvent('registration_rate_limit', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode});
      return res.status(429).json({error:'Too many registration attempts. Please try again later.'});
    }
    if ((await pool.query('SELECT id FROM members WHERE pvc=$1',[pvcUp])).rows.length) {
      await securityEvent('duplicate_pvc', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode});
      return res.status(400).json({error:'This Voters Card number is already registered'});
    }
    if ((await pool.query('SELECT id FROM members WHERE phone=$1',[phoneNorm])).rows.length) {
      await securityEvent('duplicate_phone', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode});
      return res.status(400).json({error:'This phone number is already registered'});
    }
    if (email && (await pool.query('SELECT id FROM members WHERE LOWER(email)=LOWER($1)',[String(email).trim()])).rows.length)
      suspiciousSignals.push('duplicate_email');
    if (refCode) {
      const referrer = (await pool.query('SELECT id,phone FROM members WHERE referral_code=$1',[refCode])).rows[0];
      if (!referrer) {
        await securityEvent('invalid_referral', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode});
        return res.status(400).json({error:'Invalid referral code'});
      }
      if (referrer.phone === phoneNorm) {
        await securityEvent('self_referral', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode});
        return res.status(400).json({error:'You cannot use your own referral code'});
      }
      if (await recentCount('referral_code', refCode, 24) >= 20) suspiciousSignals.push('referral_velocity');
    }
    // Validate that submitted location values match the official Nigerian data loaded by the app.
    if (NIGERIA[state] && (!NIGERIA[state][lga] || !NIGERIA[state][lga].includes(ward))) {
      await securityEvent('invalid_location', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode,state,lga,ward});
      return res.status(400).json({error:'Please select a valid State, LGA and Ward'});
    }
    if (suspiciousSignals.length) await securityEvent('suspicious_registration', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode,signals:suspiciousSignals});
    await securityEvent('registration_attempt', req, {phone:phoneNorm,pvc:pvcUp,referral_code:refCode});
    const referred_by_clean = refCode;
    const password_hash = await bcrypt.hash(password, 10);
    let referral_code = generateCode(full_name);
    while ((await pool.query('SELECT id FROM members WHERE referral_code=$1',[referral_code])).rows.length)
      referral_code = generateCode(full_name);
    const r = await pool.query(
      'INSERT INTO members (full_name,phone,email,state,lga,ward,community,senatorial_district,pvc,referral_code,referred_by,password_hash,profile_image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,full_name,referral_code,state,lga,ward,profile_image',
      [full_name,phoneNorm,email?String(email).trim():null,state,lga,ward,community,senatorial_district||null,pvcUp,referral_code,referred_by_clean,password_hash,profile_image]
    );
    if (referred_by_clean)
      await pool.query('UPDATE members SET kpower=kpower+200 WHERE referral_code=$1',[referred_by_clean]);
    const m = r.rows[0];
    const token = jwt.sign({id:m.id,referral_code:m.referral_code}, JWT_SECRET, {expiresIn:'30d'});
    res.json({success:true,token,member:{id:m.id,full_name:m.full_name,referral_code:m.referral_code,level:1,level_name:'Infant',kpower:0,state:m.state,lga:m.lga,ward:m.ward,community:m.community,senatorial_district:m.senatorial_district,referrals:0,rank_state:1,rank_national:1,profile_image:m.profile_image}});
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
    res.json({success:true,token,member:{id:m.id,full_name:m.full_name,phone:m.phone,referral_code:m.referral_code,level:lvl.level,level_name:lvl.name,kpower:m.kpower,state:m.state,lga:m.lga,ward:m.ward,community:m.community,senatorial_district:m.senatorial_district,referrals:refs,rank_state:stateRank,rank_national:natRank,profile_image:m.profile_image}});
  } catch(e) { res.status(500).json({error:'Login failed.'}); }
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM members WHERE id=$1',[req.user.id]);
    if (!r.rows.length) return res.status(404).json({error:'Not found'});
    const m = r.rows[0];
    const refs = parseInt((await pool.query('SELECT COUNT(*) FROM members WHERE referred_by=$1',[m.referral_code])).rows[0].count);
    const lvl = getLevel(refs);
    const thresholds = [0,10,20,40,60,80,100,120,140,160,180];
    const curT = thresholds[lvl.level-1];
    const nextT = thresholds[lvl.level];
    const stateRank = parseInt((await pool.query('SELECT COUNT(*)+1 as r FROM members m2 WHERE m2.state=$1 AND (SELECT COUNT(*) FROM members WHERE referred_by=m2.referral_code)>(SELECT COUNT(*) FROM members WHERE referred_by=$2) AND m2.id!=$3',[m.state,m.referral_code,m.id])).rows[0].r);
    const natRank = parseInt((await pool.query('SELECT COUNT(*)+1 as r FROM members m2 WHERE (SELECT COUNT(*) FROM members WHERE referred_by=m2.referral_code)>(SELECT COUNT(*) FROM members WHERE referred_by=$1) AND m2.id!=$2',[m.referral_code,m.id])).rows[0].r);
    const activity = (await pool.query('SELECT full_name,created_at FROM members WHERE referred_by=$1 ORDER BY created_at DESC LIMIT 5',[m.referral_code])).rows;
    const lvlNames = ['','Community Member','Community Builder','Ward Mobilizer','Ward Coordinator','LGA Organizer','LGA Leader','Senatorial Strategist','State Leader','National Champion','National Ambassador'];
    res.json({member:{full_name:m.full_name,referral_code:m.referral_code,state:m.state,lga:m.lga,ward:m.ward,community:m.community,senatorial_district:m.senatorial_district,level:lvl.level,level_name:lvl.name,kpower:m.kpower+(refs*200),referrals:refs,state_rank:stateRank,national_rank:natRank,progress_current:refs-curT,progress_total:nextT-curT,next_level_name:lvlNames[lvl.level+1]||'Legend',profile_image:m.profile_image},activity:activity.map(a=>({name:a.full_name,time:a.created_at}))});
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

app.get('/api/export-members', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, full_name, phone, email, state, lga, ward, community, senatorial_district, pvc, referral_code, referred_by, level, kpower, created_at FROM members ORDER BY created_at DESC');
    res.json(r.rows);
  } catch(e) { 
    console.error('Export error:', e);
    res.status(500).json({error:'Export failed'}); 
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
    const q = 'SELECT m.full_name,m.state,m.lga,m.ward,m.community,m.senatorial_district,m.kpower,m.level,m.profile_image,COUNT(r.id) as referrals FROM members m LEFT JOIN members r ON r.referred_by=m.referral_code ' + whereStr + 'GROUP BY m.id ORDER BY referrals DESC LIMIT 20';
    
    const result = await pool.query(q, params);
    const rows = result.rows.map(row => {
      const refs = parseInt(row.referrals);
      const lvl = getLevel(refs);
      return {
        full_name: row.full_name,
        state: row.state,
        lga: row.lga,
        ward: row.ward,
        community: row.community,
        senatorial_district: row.senatorial_district,
        referrals: refs,
        level: lvl.level,
        level_name: lvl.name,
        kpower: row.kpower + (refs * 200),
        profile_image: row.profile_image
      };
    });
    res.json(rows);
  } catch(e) { res.status(500).json({error:'Leaderboard failed.'}); }
});


const REDEEM_RATE = 2; // 200 Points = ₦100
const REDEEM_NETWORKS = ['MTN','Airtel','Glo','9mobile'];
function redemptionBalance(memberPoints, reserved) { return Math.max(0, Number(memberPoints || 0) - Number(reserved || 0)); }
app.get('/api/redemptions', auth, async (req, res) => {
  try {
    const m = (await pool.query('SELECT kpower, (SELECT COUNT(*) FROM members r WHERE r.referred_by=members.referral_code)::int AS referrals FROM members WHERE id=$1',[req.user.id])).rows[0];
    if (!m) return res.status(404).json({error:'Member not found'});
    const reserved = (await pool.query("SELECT COALESCE(SUM(points_debited),0)::int AS points FROM redemptions WHERE member_id=$1 AND status <> 'Rejected'",[req.user.id])).rows[0].points;
    const rows = (await pool.query("SELECT id,reward_type,network,RIGHT(phone,4) AS phone_last4,amount_naira,points_debited,status,created_at,reviewed_at,fulfilled_at FROM redemptions WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50",[req.user.id])).rows;
    res.json({balance:redemptionBalance(Number(m.kpower)+m.referrals*200,reserved), rate:'200 Points = ₦100', redemptions:rows});
  } catch(e) { console.error('Redemption history error:',e); res.status(500).json({error:'Redemption history unavailable'}); }
});
app.post('/api/redemptions', auth, async (req, res) => {
  const type=String(req.body.reward_type||'').toLowerCase(), network=String(req.body.network||''), phone=String(req.body.phone||'').replace(/[\s-]/g,'');
  const amount=Number(req.body.amount_naira);
  if (!['airtime','data'].includes(type)) return res.status(400).json({error:'Choose Airtime or Data'});
  if (!REDEEM_NETWORKS.includes(network)) return res.status(400).json({error:'Choose a supported network'});
  if (!/^0\d{10}$/.test(phone) && !/^234\d{10}$/.test(phone)) return res.status(400).json({error:'Enter a valid Nigerian phone number'});
  if (!Number.isInteger(amount) || amount<50 || amount>5000 || amount%50!==0) return res.status(400).json({error:'Amount must be a whole ₦50 increment between ₦50 and ₦5,000'});
  const points=amount*REDEEM_RATE, c=await pool.connect();
  try { await c.query('BEGIN');
    const m=(await c.query('SELECT kpower, (SELECT COUNT(*) FROM members r WHERE r.referred_by=members.referral_code)::int AS referrals FROM members WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
    if (!m) { await c.query('ROLLBACK'); return res.status(404).json({error:'Member not found'}); }
    const reserved=(await c.query("SELECT COALESCE(SUM(points_debited),0)::int AS points FROM redemptions WHERE member_id=$1 AND status <> 'Rejected'",[req.user.id])).rows[0].points;
    const balance=redemptionBalance(Number(m.kpower)+m.referrals*200,reserved);
    if (points>balance) { await c.query('ROLLBACK'); return res.status(400).json({error:`Insufficient Points. You need ${points.toLocaleString()} Points; available balance is ${balance.toLocaleString()}.`}); }
    const r=await c.query('INSERT INTO redemptions (member_id,reward_type,network,phone,amount_naira,points_debited) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,reward_type,network,RIGHT(phone,4) AS phone_last4,amount_naira,points_debited,status,created_at',[req.user.id,type,network,phone,amount,points]);
    await c.query('COMMIT'); res.status(201).json({success:true,redemption:r.rows[0],balance:balance-points,message:'Request submitted for admin review. No airtime or data has been delivered.'});
  } catch(e) { await c.query('ROLLBACK'); console.error('Redemption submit error:',e); res.status(500).json({error:'Could not submit redemption request'}); } finally { c.release(); }
});
app.get('/api/admin/redemptions', adminAuth, async (req,res) => { try { const r=await pool.query("SELECT r.id,r.reward_type,r.network,RIGHT(r.phone,4) AS phone_last4,r.amount_naira,r.points_debited,r.status,r.created_at,r.reviewed_at,r.fulfilled_at,m.full_name,m.id AS member_id FROM redemptions r JOIN members m ON m.id=r.member_id ORDER BY r.created_at DESC LIMIT 200"); res.json(r.rows); } catch(e){res.status(500).json({error:'Redemptions unavailable'});} });
app.post('/api/admin/redemptions/:id/status', adminAuth, async (req,res) => { const status=String(req.body.status||''); if(!['Approved','Fulfilled','Rejected'].includes(status)) return res.status(400).json({error:'Invalid status'}); const c=await pool.connect(); try { await c.query('BEGIN'); const r=await c.query('SELECT member_id,status,points_debited FROM redemptions WHERE id=$1 FOR UPDATE',[req.params.id]); if(!r.rows.length){await c.query('ROLLBACK');return res.status(404).json({error:'Redemption not found'});} const x=r.rows[0]; if((status==='Approved' && x.status!=='Pending') || (status==='Fulfilled' && x.status!=='Approved') || (status==='Rejected' && !['Pending','Approved'].includes(x.status))){await c.query('ROLLBACK');return res.status(409).json({error:'Invalid status transition'});} await c.query("UPDATE redemptions SET status=$1, reviewed_at=CASE WHEN $1 IN ('Approved','Rejected') THEN NOW() ELSE reviewed_at END, fulfilled_at=CASE WHEN $1='Fulfilled' THEN NOW() ELSE fulfilled_at END WHERE id=$2",[status,req.params.id]); if(status==='Rejected' && x.status!=='Rejected') await c.query('UPDATE members SET kpower=kpower+$1 WHERE id=$2',[x.points_debited,x.member_id]); await c.query('COMMIT'); res.json({success:true,status}); } catch(e){await c.query('ROLLBACK');res.status(500).json({error:'Status update failed'});} finally{c.release();} });

function adminAuth(req, res, next) {
  const configured = process.env.ADMIN_DASHBOARD_KEY;
  const supplied = req.headers['x-admin-key'] || req.query.key;
  if (!configured || !supplied || supplied !== configured) return res.status(401).json({error:'Admin access required'});
  next();
}
function mask(value) { if (!value) return ''; const x=String(value); return x.length<=4?'••••':x.slice(0,2)+'••••'+x.slice(-2); }
app.get('/api/feed',async(req,res)=>{try{const r=await pool.query('SELECT id,title,body,image_url,created_at FROM community_posts WHERE published=TRUE ORDER BY created_at DESC LIMIT 50');res.json(r.rows);}catch(e){res.status(500).json({error:'Feed unavailable'});}});
app.post('/api/admin/posts',adminAuth,upload.single('image'),async(req,res)=>{try{const{title,body}=req.body;if(!title||!body)return res.status(400).json({error:'Title and content are required'});const image_url=req.file?'/uploads/'+req.file.filename:null;const r=await pool.query('INSERT INTO community_posts (title,body,image_url) VALUES ($1,$2,$3) RETURNING *',[title.trim(),body.trim(),image_url]);res.json({success:true,post:r.rows[0]});}catch(e){res.status(500).json({error:'Could not publish post'});}});
app.get('/api/tasks', async (req,res)=>{const r=await pool.query('SELECT id,title,description,platform,target_url,points,created_at FROM community_tasks WHERE active=TRUE ORDER BY created_at DESC');res.json(r.rows);});
app.post('/api/tasks/:id/submit', auth, async (req,res)=>{try{const t=(await pool.query('SELECT id FROM community_tasks WHERE id=$1 AND active=TRUE',[req.params.id])).rows[0];if(!t)return res.status(404).json({error:'Task not found'});const proof=String(req.body.proof_url||'').trim();if(!proof||!/^https?:\/\//i.test(proof))return res.status(400).json({error:'Submit a public post link'});await pool.query('INSERT INTO task_submissions (task_id,member_id,proof_url) VALUES ($1,$2,$3)',[t.id,req.user.id,proof]);res.json({success:true,message:'Task submitted for verification'});}catch(e){if(e.code==='23505')return res.status(409).json({error:'Task already submitted'});res.status(500).json({error:'Submission failed'});}});
app.post('/api/admin/tasks',adminAuth,async(req,res)=>{const{title,description,platform,target_url}=req.body;if(!title||!description||!platform||!target_url)return res.status(400).json({error:'All task fields are required'});const r=await pool.query('INSERT INTO community_tasks (title,description,platform,target_url) VALUES ($1,$2,$3,$4) RETURNING *',[title,description,platform,target_url]);res.json({success:true,task:r.rows[0]});});
app.get('/api/admin/task-submissions',adminAuth,async(req,res)=>{const r=await pool.query('SELECT s.id,s.proof_url,s.status,s.points_awarded,s.created_at,t.title,m.full_name FROM task_submissions s JOIN community_tasks t ON t.id=s.task_id JOIN members m ON m.id=s.member_id ORDER BY s.created_at DESC LIMIT 100');res.json(r.rows);});
app.post('/api/admin/task-submissions/:id/review',adminAuth,async(req,res)=>{const approved=req.body.approved===true||req.body.approved==='true';const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT task_id,member_id,status FROM task_submissions WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rows.length){await c.query('ROLLBACK');return res.status(404).json({error:'Submission not found'});}const x=r.rows[0];if(x.status!=='pending'){await c.query('ROLLBACK');return res.status(409).json({error:'Already reviewed'});}const pts=(await c.query('SELECT points FROM community_tasks WHERE id=$1',[x.task_id])).rows[0].points;await c.query('UPDATE task_submissions SET status=$1,points_awarded=$2,reviewed_at=NOW() WHERE id=$3',[approved?'approved':'rejected',approved?pts:0,req.params.id]);if(approved)await c.query('UPDATE members SET kpower=kpower+$1 WHERE id=$2',[pts,x.member_id]);await c.query('COMMIT');res.json({success:true});}catch(e){await c.query('ROLLBACK');res.status(500).json({error:'Review failed'});}finally{c.release();}});
app.get('/api/admin/security', adminAuth, async (req, res) => {
  try {
    const summary = (await pool.query(`SELECT event_type, COUNT(*)::int AS count FROM security_events WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY event_type ORDER BY count DESC`)).rows;
    const events = (await pool.query(`SELECT event_type,ip_address,phone,pvc,referral_code,details,created_at FROM security_events ORDER BY created_at DESC LIMIT 100`)).rows.map(x => ({...x,phone:mask(x.phone),pvc:mask(x.pvc),ip_address:mask(x.ip_address)}));
    const totals = (await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS today FROM security_events`)).rows[0];
    res.json({summary,events,totals});
  } catch(e) { res.status(500).json({error:'Security dashboard unavailable'}); }
});

app.get('/api/stats', async (req, res) => {
  try {
    // Public campaign counters supplied by the programme team.
    // Member records remain stored in the private database.
    res.json({total_members:3424, lgas_covered:44, levels:10});
  } catch(e) { res.json({total_members:3424,lgas_covered:44,levels:10}); }
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
