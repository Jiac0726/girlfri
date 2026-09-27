const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cloud = require('./mock-wx-server-sdk');
const { createV2Api } = require('../../cloudfunctions/renianApi/v2');
const { createMediaCleanup } = require('../../cloudfunctions/mediaCleanup/worker');
const handle = createV2Api(cloud, { database: cloud.__nodeDatabase() });
let sequence = 0;
const call = (action, who = 'A', payload = {}) => handle({ action, requestId: 'album_test_' + (++sequence), ...payload }, who);
const originalSign = cloud.getTempFileURL;
beforeEach(() => cloud.__reset());
afterEach(() => { cloud.getTempFileURL = originalSign; });
async function pair() { const invite = await call('pair.create'); return call('pair.join', 'B', { inviteCode: invite.inviteCode }); }
function ready(coupleId, id, ownerOpenid = 'A') {
  cloud.__colStore('v2_media').set(id, { coupleId, ownerOpenid, status: 'ready', entryId: '', expiresAt: new Date(Date.now() + 3600000), fileID: 'cloud://mock-env.bucket/v2-published/' + id + '.png' });
}
test('shared albums: create/add retry once, partner view, author-only deletion and cleanup', async () => {
  const p = await pair();
  const input = { title: '我们的旅行', requestId: 'create_album_once' };
  const album = await call('album.create', 'A', input);
  assert.equal((await call('album.create', 'A', input)).id, album.id);
  assert.equal((await call('album.list', 'B')).items.length, 1);
  ready(p.coupleId, 'm1'); ready(p.coupleId, 'm2');
  const batch = { albumId: album.id, images: ['m1', 'm2'], requestId: 'upload_album_once' };
  const uploaded = await call('album.addPhotos', 'A', batch);
  await call('album.addPhotos', 'A', batch);
  const result = await call('album.photos', 'B', { albumId: album.id });
  assert.equal(result.album.photoCount, 2); assert.equal(result.items.length, 2);
  assert.ok(result.items.every(x => x.url && !x.fromMe));
  assert.ok((await call('media.urls', 'B', { ids: ['m1'] })).items[0].url);
  await assert.rejects(call('album.deletePhoto', 'B', { id: uploaded.ids[0], expectedVersion: 1 }), e => e.code === 'FORBIDDEN');
  const removal = { id: uploaded.ids[0], expectedVersion: 1, requestId: 'delete_album_once' };
  await call('album.deletePhoto', 'A', removal); await call('album.deletePhoto', 'A', removal);
  assert.equal((await call('album.photos', 'B', { albumId: album.id })).album.photoCount, 1);
  await assert.rejects(call('media.urls', 'B', { ids: ['m1'] }));
  await createMediaCleanup(cloud, () => new Date(Date.now() + 1000)).run();
  assert.equal(cloud.__colStore('v2_media').get('m1').status, 'deleted');
  assert.equal(cloud.__colStore('v2_media').get('m2').status, 'attached');
});
test('foreign pair cannot access album, photos or signed URLs; partner cannot attach someone else media', async () => {
  const p = await pair(); const album = await call('album.create', 'A', { title: '私属两人' }); ready(p.coupleId, 'm1');
  await assert.rejects(call('album.addPhotos', 'B', { albumId: album.id, images: ['m1'] }), e => e.code === 'FORBIDDEN');
  await call('album.addPhotos', 'A', { albumId: album.id, images: ['m1'] });
  const invite = await call('pair.create', 'C'); await call('pair.join', 'D', { inviteCode: invite.inviteCode });
  assert.equal((await call('album.list', 'C')).items.length, 0);
  await assert.rejects(call('album.photos', 'C', { albumId: album.id }), e => e.code === 'NOT_FOUND');
  await assert.rejects(call('media.urls', 'C', { ids: ['m1'] }), e => e.code === 'NOT_FOUND');
});
test('album batch is atomic and rejects expired or already used media', async () => {
  const p = await pair(); const album = await call('album.create', 'A', { title: '回忆' });
  ready(p.coupleId, 'good'); ready(p.coupleId, 'expired');
  cloud.__colStore('v2_media').get('expired').expiresAt = new Date(0);
  await assert.rejects(call('album.addPhotos', 'A', { albumId: album.id, images: ['good', 'expired'] }), e => e.code === 'MEDIA_UNAVAILABLE');
  assert.equal((await call('album.photos', 'A', { albumId: album.id })).items.length, 0);
  assert.equal(cloud.__colStore('v2_media').get('good').status, 'ready');
  await call('album.addPhotos', 'A', { albumId: album.id, images: ['good'] });
  await assert.rejects(call('album.addPhotos', 'A', { albumId: album.id, images: ['good'] }), e => e.code === 'MEDIA_UNAVAILABLE');
});
test('album pagination is scoped, bounded, and signing failures preserve photo metadata', async () => {
  const p = await pair(); const album = await call('album.create', 'A', { title: '照片' });
  for (const id of ['a', 'b', 'c']) ready(p.coupleId, id);
  await call('album.addPhotos', 'A', { albumId: album.id, images: ['a', 'b', 'c'] });
  const first = await call('album.photos', 'A', { albumId: album.id, limit: 2 });
  const second = await call('album.photos', 'A', { albumId: album.id, limit: 2, cursor: first.nextCursor });
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 3);
  const other = await call('album.create', 'A', { title: '另一本' });
  await assert.rejects(call('album.photos', 'A', { albumId: other.id, cursor: first.nextCursor }), e => e.code === 'INVALID_CURSOR');
  cloud.getTempFileURL = async () => { throw Error('unavailable'); };
  const list = await call('album.photos', 'B', { albumId: album.id });
  assert.equal(list.items.length, 3); assert.ok(list.items.every(x => !x.url));
});
test('album input limits and stale deletion versions are enforced', async () => {
  const p = await pair();
  await assert.rejects(call('album.create', 'A', { title: ' ' }), e => e.code === 'INVALID_INPUT');
  const album = await call('album.create', 'A', { title: '相册' });
  await assert.rejects(call('album.addPhotos', 'A', { albumId: album.id, images: [] }), e => e.code === 'INVALID_MEDIA');
  await assert.rejects(call('album.addPhotos', 'A', { albumId: album.id, images: ['a', 'a'] }), e => e.code === 'INVALID_MEDIA');
  ready(p.coupleId, 'a'); const added = await call('album.addPhotos', 'A', { albumId: album.id, images: ['a'] });
  await assert.rejects(call('album.deletePhoto', 'A', { id: added.ids[0], expectedVersion: 2 }), e => e.code === 'VERSION_CONFLICT');
});


test('daily entry images are automatically collected into the shared daily album and survive entry deletion', async () => {
  const p = await pair();
  ready(p.coupleId, 'daily1');
  const entry = await call('entry.create', 'A', { text: '今天很好', images: ['daily1'] });
  const albums = await call('album.list', 'B');
  const daily = albums.items.find(item => item.title === '日常照片');
  assert.ok(daily);
  assert.equal(daily.photoCount, 1);
  let photos = await call('album.photos', 'B', { albumId: daily.id });
  assert.equal(photos.items.length, 1);
  assert.equal(photos.items[0].mediaId, 'daily1');
  assert.ok(photos.items[0].url);
  assert.equal(cloud.__colStore('v2_media').get('daily1').refCount, 2);

  await call('entry.delete', 'A', { id: entry.id, expectedVersion: entry.version });
  photos = await call('album.photos', 'B', { albumId: daily.id });
  assert.equal(photos.items.length, 1);
  assert.ok(photos.items[0].url);
  const media = cloud.__colStore('v2_media').get('daily1');
  assert.equal(media.status, 'attached');
  assert.equal(media.attachmentType, 'album_photo');
  assert.equal(media.refCount, 1);
});

test('deleting an auto-collected album photo does not remove the image from its daily entry', async () => {
  const p = await pair();
  ready(p.coupleId, 'daily2');
  const entry = await call('entry.create', 'A', { text: '保留在日常', images: ['daily2'] });
  const daily = (await call('album.list', 'A')).items.find(item => item.title === '日常照片');
  const photo = (await call('album.photos', 'A', { albumId: daily.id })).items[0];
  await call('album.deletePhoto', 'A', { id: photo.id, expectedVersion: photo.version });
  const refreshed = await call('entry.get', 'A', { id: entry.id });
  assert.equal(refreshed.images.length, 1);
  assert.ok(refreshed.images[0].url);
  const media = cloud.__colStore('v2_media').get('daily2');
  assert.equal(media.status, 'attached');
  assert.equal(media.attachmentType, 'entry');
  assert.equal(media.refCount, 1);
});


test('media original upload limit is 20 MB', () => {
  const { MAX_BYTES } = require('../../cloudfunctions/renianApi/v2-media');
  assert.equal(MAX_BYTES, 20 * 1024 * 1024);
});
