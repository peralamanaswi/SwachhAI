// api/index.js - Full SwachhAI API Handler for Vercel
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// ===== ENVIRONMENT CONFIGURATION =====
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const ADMIN_MOBILE = process.env.ADMIN_MOBILE || '9999999999';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Administrator';

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(morgan('combined'));

// ===== DATABASE SETUP (Lazy Loading) =====
let mongoose, User, Complaint, bcrypt, jwt, multer;
let mongoConnected = false;
let mongoConnecting = false;

async function initializeDatabase() {
  if (mongoConnected || mongoConnecting) return;
  mongoConnecting = true;

  try {
    // Load dependencies on first connection need
    if (!mongoose) {
      mongoose = require('mongoose');
      bcrypt = require('bcrypt');
      jwt = require('jsonwebtoken');
      multer = require('multer');
    }

    // Load models if needed
    if (!User) {
      User = require('../models/User');
      Complaint = require('../models/Complaint');
    }

    // Connect to MongoDB
    if (!mongoConnected && MONGO_URI) {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 10000,
      });
      mongoConnected = true;
      console.log('✓ MongoDB connected');

      // Seed admin user
      await seedAdminUser().catch(err => console.error('Seed error:', err.message));
    }
  } catch (err) {
    console.error('Database initialization error:', err.message);
    mongoConnected = false;
  } finally {
    mongoConnecting = false;
  }
}

// Seed admin user
async function seedAdminUser() {
  if (!User) return;
  try {
    const existing = await User.findOne({ mobile: ADMIN_MOBILE });
    if (existing) {
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        await existing.save();
      }
      return;
    }
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await User.create({
      name: ADMIN_NAME,
      mobile: ADMIN_MOBILE,
      passwordHash: hash,
      role: 'admin'
    });
  } catch (e) {
    console.error('Seed failed:', e.message);
  }
}

// ===== MIDDLEWARE: Ensure DB Connection =====
async function ensureDbReady(req, res, next) {
  if (!MONGO_URI) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  if (mongoConnected) return next();

  if (!mongoConnecting) {
    initializeDatabase().catch(err => console.error('Connection error:', err));
  }

  // Wait for connection (max 2 seconds)
  const start = Date.now();
  const waitForConnection = () => {
    if (mongoConnected) {
      return next();
    }
    if (Date.now() - start > 2000) {
      return res.status(503).json({ error: 'Database connection timeout' });
    }
    setImmediate(waitForConnection);
  };

  waitForConnection();
}

// ===== AUTH MIDDLEWARE =====
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
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ===== HEALTH ENDPOINT =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'SwachhAI backend is running',
    database: mongoConnected ? 'connected' : 'disconnected'
  });
});

// ===== AUTH ENDPOINTS =====
app.post('/api/auth/register', ensureDbReady, async (req, res) => {
  try {
    if (!User) {
      return res.status(500).json({ error: 'User model not available' });
    }
    const { name, mobile, password } = req.body;
    if (!name || !mobile || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
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
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', ensureDbReady, async (req, res) => {
  try {
    if (!User) {
      return res.status(500).json({ error: 'User model not available' });
    }
    const { mobile, password } = req.body;
    if (!mobile || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
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
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== COMPLAINT ENDPOINTS =====
// GET complaints for current user
app.get('/api/users/me/complaints', ensureDbReady, authMiddleware, async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Complaint model not available' });
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
    console.error('Get complaints error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create complaint (with file upload)
app.post('/api/complaints', ensureDbReady, authMiddleware, async (req, res) => {
  try {
    if (!Complaint || !multer) {
      return res.status(500).json({ error: 'Not ready for file uploads' });
    }

    // Note: File upload disabled on Vercel (ephemeral filesystem)
    // This endpoint accepts the complaint data only
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

    await c.save();
    res.status(201).json({
      id: c._id,
      status: c.status,
      createdAt: c.createdAt
    });
  } catch (e) {
    console.error('Create complaint error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN ENDPOINTS =====
app.get('/api/admin/complaints', ensureDbReady, authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Complaint model not available' });
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
    console.error('Admin list error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/complaints/:id', ensureDbReady, authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!Complaint) {
      return res.status(500).json({ error: 'Complaint model not available' });
    }

    const { status } = req.body;
    if (!['submitted', 'accepted', 'in_progress', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updated = await Complaint.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Not found' });

    res.json({ complaint: updated });
  } catch (e) {
    console.error('Admin update error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== STATIC FILES / FRONTEND =====
const publicDir = path.join(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/.*/, (req, res, next) => {
    if (req.accepts('html')) {
      res.sendFile(path.join(publicDir, 'index.html'));
    } else {
      next();
    }
  });
} else {
  app.get('/', (req, res) => {
    res.json({
      message: 'SwachhAI Backend API',
      status: 'operational',
      endpoints: {
        health: '/api/health',
        auth: '/api/auth/*',
        complaints: '/api/complaints',
        admin: '/api/admin/complaints'
      }
    });
  });
}

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ===== EXPORT =====
module.exports = app;
