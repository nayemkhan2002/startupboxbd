#!/usr/bin/env node
//
// One-time migration: JSON file store -> MongoDB Atlas.
//
//   node backend/scripts/migrate-json-to-mongo.js [--dry-run]
//
// Idempotent: documents are upserted by _id, so re-running will not
// duplicate anything. Reads from DATA_DIR (default backend/data).

const path = require('path');
const fs = require('fs');
require('dotenv').config();

const mongoose = require('mongoose');
const {
  User, Project, Interest, Investment, Withdrawal, Payout
} = require('../db/models');

const DRY_RUN = process.argv.includes('--dry-run');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

const COLLECTIONS = [
  ['users', User],
  ['projects', Project],
  ['interests', Interest],
  ['investments', Investment],
  ['withdrawals', Withdrawal],
  ['payouts', Payout]
];

const readJson = (name) => {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
  } catch (e) {
    console.error(`  ! ${name}.json is not valid JSON: ${e.message}`);
    return [];
  }
};

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  console.log(`Source : ${DATA_DIR}`);
  console.log(`Target : ${process.env.MONGO_URI.replace(/\/\/[^@]+@/, '//***:***@')}`);
  console.log(DRY_RUN ? 'Mode   : DRY RUN (no writes)\n' : 'Mode   : LIVE\n');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  let grandTotal = 0;

  for (const [name, Model] of COLLECTIONS) {
    const rows = readJson(name);
    const before = await Model.countDocuments();

    if (!rows.length) {
      console.log(`${name.padEnd(12)} source=0      mongo=${before} (nothing to do)`);
      continue;
    }

    if (!DRY_RUN) {
      const ops = rows
        .filter(r => r && r._id)
        .map(r => ({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: r },
            upsert: true
          }
        }));
      if (ops.length) await Model.bulkWrite(ops, { ordered: false });
    }

    const after = DRY_RUN ? before : await Model.countDocuments();
    grandTotal += rows.length;
    console.log(
      `${name.padEnd(12)} source=${String(rows.length).padEnd(6)} ` +
      `mongo=${before} -> ${after}`
    );
  }

  console.log(`\n${DRY_RUN ? 'Would migrate' : 'Migrated'} ${grandTotal} document(s).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
