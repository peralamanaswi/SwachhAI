// models/Complaint.js
const mongoose = require('mongoose');

const ComplaintSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: String,
  mobile: String,
  category: String,
  subcategory: String,
  desc: String,
  location: {
    lat: Number,
    lon: Number,
    locality: String,
    district: String,
    state: String,
    pincode: String,
    landmark: String
  },
  photoUrl: String,
  status: { type: String, enum: ['submitted','accepted','in_progress','closed'], default: 'submitted' },
  modelDetected: String,
  modelConfidence: Number
}, { timestamps: true });

module.exports = mongoose.model('Complaint', ComplaintSchema);
