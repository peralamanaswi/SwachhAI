// server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt'); // use bcryptjs if bcrypt install fails
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');

const User = require('./models/User');
const Complaint = require('./models/Complaint');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/swachhai';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// FRONTEND_DIR: prefer env var, otherwise try 'public' then 'SwachAI' (keeps compatibility)
const FRONTEND_DIR_CANDIDATES = [
  process.env.FRONTEND_DIR,
  path.join(__dirname, 'public'),
  path.join(__dirname, 'SwachAI')
].filter(Boolean);

let FRONTEND_DIR = null;
for (const p of FRONTEND_DIR_CANDIDATES) {
  if (fs.existsSync(p)) { FRONTEND_DIR = p; break; }
}

// Admin seed values (change via env if you want)
const ADMIN_MOBILE = process.env.ADMIN_MOBILE || '9999999999';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Administrator';

const app = express();

// middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ensure upload directory exists (use absolute path)
const uploadDirPath = path.join(__dirname, UPLOAD_DIR);
if (!fs.existsSync(uploadDirPath)) fs.mkdirSync(uploadDirPath, { recursive: true });

// serve uploaded images
app.use('/uploads', express.static(uploadDirPath));

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDirPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB

// Connect to MongoDB
// Removed deprecated mongoose options (useNewUrlParser / useUnifiedTopology) as they are no-op now.
mongoose.connect(MONGO_URI)
  .then(()=> {
    console.log('MongoDB connected');
    // seed admin after DB connected
    seedAdminUser().catch(err => console.error('seed admin error', err));
  })
  .catch(err => {
    console.error('Mongo connect error', err);
    // do not crash to allow frontend debugging
  });

// ---------------- Helper to seed admin ----------------
async function seedAdminUser(){
  try {
    if(!User) {
      console.warn('User model not found - cannot seed admin');
      return;
    }
    const existing = await User.findOne({ mobile: ADMIN_MOBILE });
    if(existing){
      if(existing.role !== 'admin'){
        existing.role = 'admin';
        await existing.save();
      }
      console.log(`Admin user already exists with mobile ${ADMIN_MOBILE}`);
      return;
    }
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await User.create({ name: ADMIN_NAME, mobile: ADMIN_MOBILE, passwordHash: hash, role: 'admin' });
    console.log('Admin user created:', { mobile: ADMIN_MOBILE, password: ADMIN_PASSWORD });
  } catch(e){
    console.error('Failed to seed admin user:', e);
  }
}

// ---------------- Auth helpers / middlewares ----------------
function authMiddleware(req, res, next){
  const auth = req.headers.authorization;
  if(!auth || !auth.startsWith('Bearer ')) return res.status(401).send('Missing token');
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, mobile, role }
    next();
  } catch(e){
    return res.status(401).send('Invalid token');
  }
}

function adminOnly(req, res, next){
  if(!req.user || req.user.role !== 'admin') return res.status(403).send('Admin only');
  next();
}

// ================= AUTH ROUTES =================

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, mobile, password } = req.body;
    if(!name || !mobile || !password) return res.status(400).send('Missing fields');
    const existing = await User.findOne({ mobile });
    if(existing) return res.status(400).send('Mobile already registered');
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, mobile, passwordHash: hash, role: 'user' });
    const token = jwt.sign({ id: user._id, mobile: user.mobile, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ user: { id: user._id, name: user.name, mobile: user.mobile, role: user.role }, accessToken: token });
  } catch(e){
    console.error('register error', e);
    res.status(500).send('Server error');
  }
});

// Login
app.post('/api/auth/login', async (req,res) => {
  try{
    const { mobile, password } = req.body;
    if(!mobile || !password) return res.status(400).send('Missing fields');
    const user = await User.findOne({ mobile });
    if(!user) return res.status(400).send('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if(!ok) return res.status(400).send('Invalid credentials');
    const token = jwt.sign({ id: user._id, mobile: user.mobile, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user: { id: user._id, name: user.name, mobile: user.mobile, role: user.role }, accessToken: token });
  }catch(e){
    console.error('login error', e);
    res.status(500).send('Server error');
  }
});

// ================= USER / COMPLAINT ROUTES =================

// Create complaint
app.post('/api/complaints', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name, mobile, category, subcategory, desc,
      locality, district, state, pincode, landmark,
      modelDetected, modelConfidence
    } = req.body;

    const c = new Complaint({
      userId,
      name, mobile,
      category, subcategory,
      desc,
      location: { locality, district, state, pincode, landmark },
      modelDetected,
      modelConfidence: modelConfidence ? parseFloat(modelConfidence) : undefined
    });

    if(req.file) {
      c.photoUrl = `/uploads/${req.file.filename}`;
    }

    await c.save();
    res.status(201).json({ id: c._id, status: c.status, photoUrl: c.photoUrl, createdAt: c.createdAt });
  } catch(e){
    console.error('create complaint error', e);
    res.status(500).send('Server error');
  }
});

// Get complaints of logged-in user
app.get('/api/users/me/complaints', authMiddleware, async (req, res) => {
  try {
    const list = await Complaint.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
    const out = list.map(c => ({
      id: c._id,
      name: c.name,
      mobile: c.mobile,
      category: c.category,
      subcategory: c.subcategory,
      desc: c.desc,
      locality: c.location?.locality,
      district: c.location?.district,
      state: c.location?.state,
      pincode: c.location?.pincode,
      landmark: c.location?.landmark,
      photoUrl: c.photoUrl,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
    res.json({ complaints: out });
  } catch(e){
    console.error('get my complaints error', e);
    res.status(500).send('Server error');
  }
});

// ================= ADMIN ROUTES =================

// Admin: list all complaints (with optional status filter)
app.get('/api/admin/complaints', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, page = 1, limit = 100 } = req.query;
    const q = status ? { status } : {};
    const skip = (Math.max(1, parseInt(page)) - 1) * Math.max(1, parseInt(limit));
    const complaints = await Complaint.find(q).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate('userId','name mobile').lean();
    res.json({ complaints, page: parseInt(page), limit: parseInt(limit) });
  } catch(e){
    console.error('admin list error', e);
    res.status(500).send('Server error');
  }
});

// Admin: update complaint status
app.patch('/api/admin/complaints/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;
    if(!['submitted','accepted','in_progress','closed'].includes(status)) return res.status(400).send('Invalid status');
    const updated = await Complaint.findByIdAndUpdate(id, { status, updatedAt: new Date() }, { new: true }).lean();
    if(!updated) return res.status(404).send('Not found');
    res.json({ complaint: updated });
  } catch(e){
    console.error('admin update error', e);
    res.status(500).send('Server error');
  }
});

// Health check
app.get('/api/health', (req,res) => res.json({ ok: true, message: 'SwachhAI backend is running' }));

// ---------------- Serve frontend (static) ----------------
if (FRONTEND_DIR && fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  console.log('Serving frontend from:', FRONTEND_DIR);

  // SPA fallback - only return index.html for HTML accept requests
  app.get(/.*/, (req, res, next) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    }
    next();
  });
} else {
  console.warn('Frontend folder not found. Tried:', FRONTEND_DIR_CANDIDATES.join(' | '));
  // basic root to indicate backend running
  app.get('/', (req,res) => res.send('SwachhAI backend is running - frontend not found'));
}

// Start server
app.listen(PORT, ()=> console.log(`Server listening on port ${PORT}`));
