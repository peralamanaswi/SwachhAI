// api/health.js - Minimal test handler
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Minimal test endpoint',
    timestamp: new Date().toISOString()
  });
};
