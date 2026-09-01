// api/index.js - Minimal Vercel serverless handler
const express = require('express');
const app = express();

// Basic middleware
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'API is running' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'SwachhAI backend', status: 'operational' });
});

// Export for Vercel
module.exports = app;
