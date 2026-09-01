// api/index.js - Vercel serverless handler
// Note: Don't require dotenv in Vercel - use environment variables directly

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');

// Import models
let User, Complaint;
try {
  User = require('../models/User');
  Complaint = require('../models/Complaint');
  console.log('Models loaded successfully');
} catch (err) {
  console.error('Failed to load models:', err.message);
}

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/swachhai';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Admin seed values
const ADMIN_MOBILE = process.env.ADMIN_MOBILE || '9999999999';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Administrator';

const app = express();

// Determine frontend directory
const FRONTEND_DIR_CANDIDATES = [
  process.env.FRONTEND_DIR,
  path.join(__dirname, '../public'),
  path.join(__dirname, '../SwachAI')
].filter(Boolean);

let FRONTEND_DIR = null;
for (const p of FRONTEND_DIR_CANDIDATES) {
  if (fs.existsSync(p)) { 
    FRONTEND_DIR = p; 
    console.log('Frontend directory found:', FRONTEND_DIR);
    break; 
  }
}

if (!FRONTEND_DIR) {
  console.warn('Frontend folder not found. Tried:', FRONTEND_DIR_CANDIDATES.join(' | '));
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Ensure upload directory exists
const uploadDirPath = path.join(__dirname, '..', UPLOAD_DIR);
try {
  if (!fs.existsSync(uploadDirPath)) {
    fs.mkdirSync(uploadDirPath, { recursive: true });
  }
  app.use('/uploads', express.static(uploadDirPath));
} catch (err) {
  console.error('Upload directory error:', err.message);
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDirPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 8 * 1024 * 1024 },
  onError: (err, next) => {
    console.error('Multer error:', err);
    next(err);
  }
});

// MongoDB connection management
let mongoConnected = false;
let mongoConnecting = false;
const MAX_CONNECTION_ATTEMPTS = 3;
let connectionAttempts = 0;

async function connectMongo() {
  if (mongoConnected) {
    console.log('MongoDB already connected');
    return;
  }
  if (mongoConnecting) {
    console.log('MongoDB connection in progress');
    return;
  }
  if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
    console.warn('Max MongoDB connection attempts reached');
    return;
  }

  mongoConnecting = true;
  connectionAttempts++;
  
  try {
    console.log(`MongoDB connection attempt ${connectionAttempts}...`);
    await mongoose.connect(MONGO_URI, { 
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
    });
    mongoConnected = true;
    console.log('✓ MongoDB connected successfully');
    
    // Seed admin user
    if (User && Complaint) {
      await seedAdminUser().catch(err => console.error('Seed error:', err.message));
    }
  } catch (err) {
    console.error(`✗ MongoDB connection failed (attempt ${connectionAttempts}):`, err.message);
    mongoConnected = false;
  } finally {
    mongoConnecting = false;
  }
}

// Seed admin user
async function seedAdminUser() {
  try {
    if (!User) {
      console.warn('User model not available');
      return;
    }
    const existing = await User.findOne({ mobile: ADMIN_MOBILE });
    if (existing) {
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        await existing.save();
      }
      console.log('Admin user exists');
      return;
    }
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await User.create({
      name: ADMIN_NAME,
      mobile: ADMIN_MOBILE,
      passwordHash: hash,
      role: 'admin'
    });
    console.log('Admin user created');
  } catch (e) {
    console.error('Failed to seed admin user:', e.message);
  }
}

// Attempt initial MongoDB connection (non-blocking)
connectMongo().catch(err => console.error('Initial connection error:', err));

// Middleware to ensure MongoDB is connected
function ensureMongoConnected(req, res, next) {
  if (mongoConnected) {
    return next();
  }
  // Try to connect if not already attempting
  if (!mongoConnecting && connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
    connectMongo().catch(err => console.error('Connection attempt failed:', err));
  }
  // Wait briefly for connection
  const waitUntil = Date.now() + 1000;
  const check = () => {
    if (mongoConnected) {
      return next();
    }
    if (Date.now() < waitUntil) {
      setImmediate(check);
    } else {
      res.status(503).json({ error: 'Database connection unavailable', ok: false });
    }
  };
  check();
}

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'SwachhAI backend is running',
    mongo: mongoConnected ? 'connected' : 'disconnected'
  });
});

// ===== AUTH ROUTES =====
app.post('/api/auth/register', ensureMongoConnected, async (req, res) => {
  try {
    if (!User || !Complaint) {
      return res.status(500).json({ error: 'Database models not initialized' });
    }
    const { name, mobile, password } = req.body;
    if (!name || !mobile || !password) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const existing = await User.findOne({ mobile });
    if (existing) {
      return res.status(400).json({ error: 'Mobile already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, mobile, passwordHash: hash, role: 'user' });
    const token = jwt.sign(
      { id: user._id, mobile: user.mobile, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({
      user: { id: user._id, name: user.name, mobile: user.mobile, role: user.role },
      accessToken: token
    });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

app.post('/api/auth/login', ensureMongoConnected, async (req, res) => {
  try {
    if (!User) {
      return res.status(500).json({ error: 'Database models not initialized' });
    }
    const { mobile, password } = req.body;
    if (!mobile || !password) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const user = await User.findOne({ mobile });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user._id, mobile: user.mobile, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      user: { id: user._id, name: user.name, mobile: user.mobile, role: user.role },
      accessToken: token
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// ===== COMPLAINT ROUTES =====
app.post('/api/complaints', ensureMongoConnected, authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Database models not initialized' });
    }
    const userId = req.user.id;
    const {
      name, mobile, category, subcategory, desc,
      locality, district, state, pincode, landmark,
      modelDetected, modelConfidence
    } = req.body;

    const c = new Complaint({
      userId,
      name, mobile, category, subcategory, desc,
      location: { locality, district, state, pincode, landmark },
      modelDetected,
      modelConfidence: modelConfidence ? parseFloat(modelConfidence) : undefined
    });

    if (req.file) {
      c.photoUrl = `/uploads/${req.file.filename}`;
    }

    await c.save();
    res.status(201).json({
      id: c._id,
      status: c.status,
      photoUrl: c.photoUrl,
      createdAt: c.createdAt
    });
  } catch (e) {
    console.error('create complaint error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

app.get('/api/users/me/complaints', ensureMongoConnected, authMiddleware, async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Database models not initialized' });
    }
    const list = await Complaint.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
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
  } catch (e) {
    console.error('get my complaints error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// ===== ADMIN ROUTES =====
app.get('/api/admin/complaints', ensureMongoConnected, authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Database models not initialized' });
    }
    const { status, page = 1, limit = 100 } = req.query;
    const q = status ? { status } : {};
    const skip = (Math.max(1, parseInt(page)) - 1) * Math.max(1, parseInt(limit));
    const complaints = await Complaint.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('userId', 'name mobile')
      .lean();
    res.json({ complaints, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    console.error('admin list error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

app.patch('/api/admin/complaints/:id', ensureMongoConnected, authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Database models not initialized' });
    }
    const id = req.params.id;
    const { status } = req.body;
    if (!['submitted', 'accepted', 'in_progress', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const updated = await Complaint.findByIdAndUpdate(
      id,
      { status, updatedAt: new Date() },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ complaint: updated });
  } catch (e) {
    console.error('admin update error:', e);
    res.status(500).json({ error: 'Server error', details: e.message });
  }
});

// ===== SERVE FRONTEND =====
if (FRONTEND_DIR && fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));

  // SPA fallback
  app.get(/.*/, (req, res, next) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    }
    next();
  });
} else {
  app.get('/', (req, res) => {
    res.json({ 
      message: 'SwachhAI backend is running',
      note: 'Frontend not found - configure FRONTEND_DIR environment variable'
    });
  });
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Export for Vercel serverless
module.exports = app;

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/swachhai';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Determine frontend directory
const FRONTEND_DIR_CANDIDATES = [
  process.env.FRONTEND_DIR,
  path.join(__dirname, '../public'),
  path.join(__dirname, '../SwachAI')
].filter(Boolean);

let FRONTEND_DIR = null;
for (const p of FRONTEND_DIR_CANDIDATES) {
  if (fs.existsSync(p)) { FRONTEND_DIR = p; break; }
}

// Admin seed values
const ADMIN_MOBILE = process.env.ADMIN_MOBILE || '9999999999';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Administrator';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Ensure upload directory exists
const uploadDirPath = path.join(__dirname, '..', UPLOAD_DIR);
if (!fs.existsSync(uploadDirPath)) {
  fs.mkdirSync(uploadDirPath, { recursive: true });
}

// Serve uploaded images
app.use('/uploads', express.static(uploadDirPath));

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDirPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// MongoDB connection
let mongoConnected = false;
let mongoConnecting = false;

async function connectMongo() {
  if (mongoConnected) return;
  if (mongoConnecting) return; // prevent concurrent connections
  
  mongoConnecting = true;
  try {
    await mongoose.connect(MONGO_URI, { 
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    mongoConnected = true;
    console.log('MongoDB connected');
    await seedAdminUser().catch(err => console.error('Seed error:', err.message));
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    mongoConnected = false;
  } finally {
    mongoConnecting = false;
  }
}

// Attempt initial connection (don't wait for it)
connectMongo().catch(err => console.error('Initial MongoDB connection failed:', err.message));

// Seed admin user
async function seedAdminUser() {
  try {
    if (!User) {
      console.warn('User model not found');
      return;
    }
    const existing = await User.findOne({ mobile: ADMIN_MOBILE });
    if (existing) {
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        await existing.save();
      }
      console.log(`Admin user exists with mobile ${ADMIN_MOBILE}`);
      return;
    }
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await User.create({
      name: ADMIN_NAME,
      mobile: ADMIN_MOBILE,
      passwordHash: hash,
      role: 'admin'
    });
    console.log('Admin user created');
  } catch (e) {
    console.error('Failed to seed admin user:', e.message);
  }
}

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).send('Missing token');
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).send('Invalid token');
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).send('Admin only');
  next();
}

// Middleware to ensure MongoDB is connected before database operations
function ensureMongoConnected(req, res, next) {
  if (mongoConnected) {
    return next();
  }
  // Try to connect if not already attempting
  if (!mongoConnecting) {
    connectMongo().catch(err => console.error('Connection attempt failed:', err.message));
  }
  // Wait a bit and retry
  setTimeout(() => {
    if (mongoConnected) {
      next();
    } else {
      res.status(503).send('Database connection unavailable');
    }
  }, 500);
}

// ===== AUTH ROUTES =====

app.post('/api/auth/register', ensureMongoConnected, async (req, res) => {
  try {
    const { name, mobile, password } = req.body;
    if (!name || !mobile || !password) return res.status(400).send('Missing fields');
    const existing = await User.findOne({ mobile });
    if (existing) return res.status(400).send('Mobile already registered');
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, mobile, passwordHash: hash, role: 'user' });
    const token = jwt.sign(
      { id: user._id, mobile: user.mobile, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({
      user: { id: user._id, name: user.name, mobile: user.mobile, role: user.role },
      accessToken: token
    });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).send('Server error');
  }
});

app.post('/api/auth/login', ensureMongoConnected, async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!mobile || !password) return res.status(400).send('Missing fields');
    const user = await User.findOne({ mobile });
    if (!user) return res.status(400).send('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).send('Invalid credentials');
    const token = jwt.sign(
      { id: user._id, mobile: user.mobile, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      user: { id: user._id, name: user.name, mobile: user.mobile, role: user.role },
      accessToken: token
    });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).send('Server error');
  }
});

// ===== COMPLAINT ROUTES =====

app.post('/api/complaints', ensureMongoConnected, authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name, mobile, category, subcategory, desc,
      locality, district, state, pincode, landmark,
      modelDetected, modelConfidence
    } = req.body;

    const c = new Complaint({
      userId,
      name,
      mobile,
      category,
      subcategory,
      desc,
      location: { locality, district, state, pincode, landmark },
      modelDetected,
      modelConfidence: modelConfidence ? parseFloat(modelConfidence) : undefined
    });

    if (req.file) {
      c.photoUrl = `/uploads/${req.file.filename}`;
    }

    await c.save();
    res.status(201).json({
      id: c._id,
      status: c.status,
      photoUrl: c.photoUrl,
      createdAt: c.createdAt
    });
  } catch (e) {
    console.error('create complaint error:', e);
    res.status(500).send('Server error');
  }
});

app.get('/api/users/me/complaints', ensureMongoConnected, authMiddleware, async (req, res) => {
  try {
    const list = await Complaint.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
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
  } catch (e) {
    console.error('get my complaints error:', e);
    res.status(500).send('Server error');
  }
});

// ===== ADMIN ROUTES =====

app.get('/api/admin/complaints', ensureMongoConnected, authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, page = 1, limit = 100 } = req.query;
    const q = status ? { status } : {};
    const skip = (Math.max(1, parseInt(page)) - 1) * Math.max(1, parseInt(limit));
    const complaints = await Complaint.find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('userId', 'name mobile')
      .lean();
    res.json({ complaints, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    console.error('admin list error:', e);
    res.status(500).send('Server error');
  }
});

app.patch('/api/admin/complaints/:id', ensureMongoConnected, authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;
    if (!['submitted', 'accepted', 'in_progress', 'closed'].includes(status)) {
      return res.status(400).send('Invalid status');
    }
    const updated = await Complaint.findByIdAndUpdate(
      id,
      { status, updatedAt: new Date() },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).send('Not found');
    res.json({ complaint: updated });
  } catch (e) {
    console.error('admin update error:', e);
    res.status(500).send('Server error');
  }
});

// Health check
app.get('/api/health', (req, res) =>
  res.json({ ok: true, message: 'SwachhAI backend is running' })
);

// Serve frontend
if (FRONTEND_DIR && fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  console.log('Serving frontend from:', FRONTEND_DIR);

  // SPA fallback
  app.get(/.*/, (req, res, next) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    }
    next();
  });
} else {
  console.warn('Frontend folder not found. Tried:', FRONTEND_DIR_CANDIDATES.join(' | '));
  app.get('/', (req, res) => res.send('SwachhAI backend is running - frontend not found'));
}

// Export for Vercel serverless
module.exports = app;
