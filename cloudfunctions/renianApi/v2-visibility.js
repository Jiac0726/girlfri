'use strict';
function entryVisibleTo(entry, openid) {
  return !entry.legacyPrivate || entry.authorOpenid === openid;
}
module.exports = { entryVisibleTo };
