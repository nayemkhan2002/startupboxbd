// Storage backend selector.
//
// MONGO_URI set  -> MongoDB Atlas (production)
// MONGO_URI unset -> local JSON files (development / offline fallback)
//
// Both modules expose an identical API, so nothing downstream changes.
const useMongo = Boolean(process.env.MONGO_URI);

console.log(`Storage backend: ${useMongo ? 'MongoDB' : 'JSON files'}`);

module.exports = useMongo
  ? require('./mongoDb')
  : require('./jsonDb');
