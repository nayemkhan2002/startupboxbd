// Storage backend selector.
//
// MONGO_URI set and USE_JSON_DB !== 'true' -> MongoDB Atlas (production)
// MONGO_URI unset or USE_JSON_DB === 'true'  -> local JSON files (development / offline fallback)
//
// Both modules expose an identical API, so nothing downstream changes.
const useMongo = Boolean(process.env.MONGO_URI) && process.env.USE_JSON_DB !== 'true';

console.log(`Storage backend: ${useMongo ? 'MongoDB' : 'JSON files'}`);

module.exports = useMongo
  ? require('./mongoDb')
  : require('./jsonDb');
