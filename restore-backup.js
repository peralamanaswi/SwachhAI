#!/usr/bin/env node
// restore-backup.js - Better BSON restoration

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const bson = require('bson');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/swachhai';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'swachhai-backup', 'swachhai');

function readBSONFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const docs = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) break;

    const size = buffer.readInt32LE(offset);
    if (size <= 0 || offset + size > buffer.length) break;

    try {
      const doc = bson.deserialize(buffer.slice(offset, offset + size));
      docs.push(doc);
    } catch (e) {
      console.error('Error deserializing BSON at offset', offset, ':', e.message);
      break;
    }

    offset += size;
  }

  return docs;
}

async function restore() {
  const client = new MongoClient(MONGO_URI);

  try {
    console.log('📦 Connecting to MongoDB Atlas...');
    await client.connect();
    const db = client.db('swachhai');
    console.log('✓ Connected to swachhai database');

    // Restore users
    const usersPath = path.join(BACKUP_DIR, 'users.bson');
    if (fs.existsSync(usersPath)) {
      console.log('\n📥 Restoring users...');
      const users = readBSONFile(usersPath);
      if (users.length > 0) {
        await db.collection('users').deleteMany({});
        const result = await db.collection('users').insertMany(users);
        console.log(`✓ Restored ${result.insertedCount} users`);
      } else {
        console.log('⚠ No users found in backup');
      }
    }

    // Restore complaints
    const complaintsPath = path.join(BACKUP_DIR, 'complaints.bson');
    if (fs.existsSync(complaintsPath)) {
      console.log('\n📥 Restoring complaints...');
      const complaints = readBSONFile(complaintsPath);
      if (complaints.length > 0) {
        await db.collection('complaints').deleteMany({});
        const result = await db.collection('complaints').insertMany(complaints);
        console.log(`✓ Restored ${result.insertedCount} complaints`);
      } else {
        console.log('⚠ No complaints found in backup');
      }
    }

    // Verify collections
    console.log('\n📊 Verification:');
    const userCount = await db.collection('users').countDocuments();
    const complaintCount = await db.collection('complaints').countDocuments();
    console.log(`  Users in database: ${userCount}`);
    console.log(`  Complaints in database: ${complaintCount}`);

    if (userCount > 0 || complaintCount > 0) {
      console.log('\n✅ Backup restore completed successfully!');
    } else {
      console.log('\n⚠ Warning: Backup appears to be empty or corrupt');
    }
  } catch (err) {
    console.error('\n❌ Restore failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await client.close();
  }
}

restore();
