'use strict';

const crypto = require('crypto');
const { assert, fail, randomId } = require('./v2-core');
const TTL = 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() { return Array.from(crypto.randomBytes(8), n => ALPHABET[n % ALPHABET.length]).join(''); }

function createPairs(ctx) {
  const { db, get, put, remove, membership, session } = ctx;
  async function issue(openid, refresh) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = inviteCode();
      const id = randomId('pair');
      try {
        return await db.runTransaction(async tx => {
          const member = await membership(tx, openid, false);
          if (member.pair && member.pair.status === 'active') {
            if (refresh) fail('INVITE_NOT_AVAILABLE', '已经完成绑定，请刷新状态');
            return session(openid, member);
          }
          if (refresh) assert(member.pair, 'NOT_BOUND', '请先发起邀请');
          if (member.pair) {
            assert(member.pair.status === 'waiting' && member.pair.creatorOpenid === openid, 'PAIR_INVALID', '关系状态异常');
            if (!refresh && new Date(member.pair.inviteExpiresAt).getTime() > Date.now()) return session(openid, member);
          }
          assert(!await get(tx, 'invites', code), 'INVITE_COLLISION', '请重新生成邀请码');
          const now = new Date();
          const pair = Object.assign({}, member.pair || {}, {
            _id: member.pair ? member.pair._id : id,
            creatorOpenid: openid, partnerOpenid: '', memberOpenids: [openid], status: 'waiting',
            inviteCode: code, inviteExpiresAt: new Date(now.getTime() + TTL),
            createdAt: member.pair ? member.pair.createdAt : now, updatedAt: now,
            version: (member.pair ? member.pair.version : 0) + 1,
          });
          if (member.pair && member.pair.inviteCode) await remove(tx, 'invites', member.pair.inviteCode);
          await put(tx, 'invites', code, { coupleId: pair._id, creatorOpenid: openid, expiresAt: pair.inviteExpiresAt, createdAt: now });
          await put(tx, 'couples', pair._id, pair);
          const user = Object.assign({}, member.user || {}, { coupleId: pair._id, status: 'waiting', createdAt: member.user && member.user.createdAt || now, updatedAt: now });
          await put(tx, 'users', openid, user);
          return session(openid, { user, pair });
        });
      } catch (error) { if (error.code !== 'INVITE_COLLISION') throw error; }
    }
    fail('INVITE_CREATE_FAILED', '暂时无法生成邀请码，请稍后重试');
  }
  async function cancel(openid) {
    return db.runTransaction(async tx => {
      const member = await membership(tx, openid, false);
      if (!member.pair) return session(openid, member);
      assert(member.pair.status === 'waiting' && member.pair.creatorOpenid === openid, 'CANNOT_CANCEL', '已经完成绑定，请刷新状态');
      await remove(tx, 'invites', member.pair.inviteCode);
      await remove(tx, 'couples', member.pair._id);
      const user = Object.assign({}, member.user, { coupleId: '', status: 'unbound', updatedAt: new Date() });
      await put(tx, 'users', openid, user);
      return session(openid, { user, pair: null });
    });
  }
  async function join(openid, value) {
    const code = String(value || '').trim().toUpperCase();
    assert(/^[A-Z2-9]{8}$/.test(code), 'INVALID_INVITE', '请输入正确的 8 位邀请码');
    return db.runTransaction(async tx => {
      const member = await membership(tx, openid, false);
      assert(!member.pair || member.pair.status === 'waiting', 'ALREADY_BOUND', '你已经完成绑定');
      const invitation = await get(tx, 'invites', code);
      assert(invitation, 'INVITE_NOT_FOUND', '邀请码不存在或已经使用');
      const pair = await get(tx, 'couples', invitation.coupleId);
      assert(pair && pair.status === 'waiting' && pair.inviteCode === code, 'INVITE_NOT_FOUND', '邀请码不存在或已经使用');
      assert(pair.creatorOpenid !== openid, 'SELF_JOIN', '不能接受自己的邀请');
      assert(new Date(pair.inviteExpiresAt).getTime() > Date.now(), 'INVITE_EXPIRED', '邀请已过期，请让对方重新生成');
      const creator = await get(tx, 'users', pair.creatorOpenid);
      assert(creator && creator.coupleId === pair._id && creator.status === 'waiting', 'PAIR_INVALID', '邀请状态异常，请对方重新生成');
      if (member.pair) assert(member.pair.creatorOpenid === openid && member.pair.status === 'waiting', 'ALREADY_BOUND', '你已经存在绑定关系');
      const now = new Date();
      // Validate the target before deleting the caller's pending invitation; all changes commit together.
      if (member.pair) {
        await remove(tx, 'invites', member.pair.inviteCode);
        await remove(tx, 'couples', member.pair._id);
      }
      pair.status = 'active'; pair.partnerOpenid = openid; pair.memberOpenids = [pair.creatorOpenid, openid];
      pair.inviteCode = ''; pair.inviteExpiresAt = null; pair.activatedAt = now; pair.updatedAt = now; pair.version += 1;
      await put(tx, 'couples', pair._id, pair);
      await remove(tx, 'invites', code);
      const user = Object.assign({}, member.user || {}, { coupleId: pair._id, status: 'active', createdAt: member.user && member.user.createdAt || now, updatedAt: now });
      await put(tx, 'users', openid, user);
      await put(tx, 'users', pair.creatorOpenid, Object.assign({}, creator, { status: 'active', updatedAt: now }));
      return session(openid, { user, pair });
    });
  }
  return { issue, cancel, join };
}

module.exports = { createPairs };
