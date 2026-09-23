let local = {};

try {
  local = require('./env.local');
} catch (e) {
  // env.local.js is machine-local and intentionally not committed.
}

const cloudEnv = String((local && local.cloudEnv) || '').trim();

module.exports = {
  cloudEnv,
  configured: !!cloudEnv && cloudEnv !== 'YOUR_ENV_ID',
};
