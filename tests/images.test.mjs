import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectImage, prepareImage } from '../src/images.cjs';
import { normalizeSettings } from '../src/settings.mjs';

test('wallpaper headers are checked before invoking a native decoder', () => {
  const jpeg = fs.readFileSync(new URL('../runtime/ocean-preview.jpg', import.meta.url));
  assert.deepEqual(inspectImage(jpeg), {height:974,width:960,type:'jpg'});
  const png = Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(20000,16);png.writeUInt32BE(20000,20);
  let decoded = false;
  assert.throws(()=>prepareImage(png,{createFromBuffer(){decoded=true;}}));
  assert.equal(decoded,false);
  for(const invalid of [Buffer.from('<svg width="100" height="100"></svg>'),Buffer.alloc(11*1024*1024)]) assert.throws(()=>inspectImage(invalid));
});

test('large wallpaper encoding is reduced to the transport budget and survives settings normalization',()=>{
  const jpeg=fs.readFileSync(new URL('../runtime/ocean-preview.jpg',import.meta.url));
  let size={width:7680,height:4320}, attempts=0;
  const fake={isEmpty:()=>false,getSize:()=>size,resize(next){size={width:next.width,height:next.height??Math.round(size.height*next.width/size.width)};return this;},toJPEG(){attempts++;return attempts<3?Buffer.alloc(3*1024*1024):Buffer.alloc(300000,65);}};
  const uri=prepareImage(jpeg,{createFromBuffer:()=>fake});
  assert.equal(attempts,3);assert.ok(size.width<3840);
  assert.equal(normalizeSettings({theme:'custom',imageData:uri}).theme,'custom');
  assert.throws(()=>normalizeSettings({imageData:'data:image/jpeg;base64,'+Buffer.alloc(2*1024*1024+1).toString('base64')}));
});
