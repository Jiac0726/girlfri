const local = require('./env.local');

const cloudEnv = String((local && local.cloudEnv) || '').trim();

module.exports = {
  cloudEnv,
  configured: !!cloudEnv && cloudEnv !== 'YOUR_ENV_ID',
};
