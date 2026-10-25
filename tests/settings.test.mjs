import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSettings,DEFAULTS,rasterMime} from '../src/settings.mjs';
test('defaults and bounded settings',()=>{
  assert.deepEqual(normalizeSettings(),DEFAULTS);
  assert.equal(normalizeSettings({opacity:0,wave:500}).opacity,15);
  assert.equal(normalizeSettings({wave:500}).wave,100);
  assert.throws(()=>normalizeSettings({opacity:NaN}));
});
test('custom images cannot be scripts or remote resources',()=>{
  for(const imageData of ['https://example.org/a.png','data:image/svg+xml;base64,PHN2Zz4=','javascript:alert(1)']) assert.throws(()=>normalizeSettings({imageData}));
  assert.equal(normalizeSettings({theme:'custom'}).theme,'ocean');
  assert.throws(()=>rasterMime(Buffer.from('<html>not an image</html>')));
});
test('local video preferences survive before a runtime URL is available',()=>{
  const videoId='0123456789abcdef0123456789abcdef';
  const result=normalizeSettings({theme:'video',videoId,videoName:'My clip.mov'});
  assert.equal(result.theme,'video');
  assert.equal(result.videoId,videoId);
  assert.equal(result.videoName,'My clip.mov');
  assert.equal(result.videoUrl,null);
  assert.equal(normalizeSettings({theme:'video'}).theme,'ocean');
  assert.throws(()=>normalizeSettings({videoId:'../outside'}));
  assert.throws(()=>normalizeSettings({videoId:videoId+'\n'}));
  assert.throws(()=>normalizeSettings({videoName:'x'.repeat(121)}));
  assert.throws(()=>normalizeSettings({videoName:123}));
});
test('only exact HTTPS loopback media URLs bound to the selected video ID are accepted',()=>{
  const videoId='0123456789abcdef0123456789abcdef';
  const token='f'.repeat(32),videoUrl=`https://127.0.0.1/open-sea-media/${token}/${videoId}`;
  assert.equal(normalizeSettings({theme:'video',videoId,videoUrl}).videoUrl,videoUrl);
  for(const invalid of [
    'https://example.org/a.mp4','file:///tmp/movie.mp4','blob:app://-/id','data:video/mp4;base64,AAAA',
    `app://-/open-sea-media/${token}/${videoId}`, `open-sea-media://${token}/${videoId}`,
    videoUrl+'?x=1',videoUrl+'#x',videoUrl+'/',videoUrl.replace('/open-sea-media/','/open-sea-media/../'),
    ...['127.0.0.2','localhost','[::1]','127.0.0.1:443','127.0.0.1:8443','user@127.0.0.1',
      '127.0.0.1.example.org','example.org','2130706433'].map(host=>videoUrl.replace('127.0.0.1',host)),
    videoUrl.replace('https:','http:'),videoUrl.replace('https:','HTTPS:'),
    videoUrl+'\n',videoUrl+'\r\n',videoUrl+' ',videoUrl.replace('127.0.0.1','127.0.0.\t1'),
    `https://127.0.0.1/open-sea-media/${token}/${'a'.repeat(32)}`,
    `https://127.0.0.1/open-sea-media/${token}/%30${videoId.slice(1)}`,
    `https://127.0.0.1/open-sea-media/${token.slice(1)}/${videoId}`,
  ])assert.throws(()=>normalizeSettings({theme:'video',videoId,videoUrl:invalid}),invalid);
  assert.throws(()=>normalizeSettings({videoUrl}),'a URL without its selected ID is invalid');
});
