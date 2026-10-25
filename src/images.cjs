const { imageSize } = require('image-size');

// Read headers before native decoding, so small compressed files cannot request
// an unbounded pixel allocation. Only the three supported raster types pass.
function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 10 * 1024 * 1024) throw new Error('请选择 10 MB 以内的图片 / Choose an image under 10 MB.');
  const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const webp = buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('仅支持 PNG、JPEG、WebP / Only PNG, JPEG and WebP are supported.');
  let size;
  try { size = imageSize(buffer); } catch { throw new Error('图片文件无效 / Invalid image file.'); }
  if (!['png','jpg','webp'].includes(size.type) || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384 || size.width * size.height > 50000000) {
    throw new Error('图片尺寸过大或无效，请先缩小 / Image dimensions are too large or invalid. Resize it first.');
  }
  return size;
}

function prepareImage(buffer, nativeImage) {
  inspectImage(buffer);
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error('无法读取图片 / Cannot decode this image.');
  const size = image.getSize();
  const factor = Math.min(1, 3840 / Math.max(size.width, size.height));
  if (factor < 1) image = image.resize({width: Math.max(1, Math.round(size.width * factor)),height: Math.max(1, Math.round(size.height * factor))});
  for (let attempt = 0; attempt < 8; attempt++) {
    const output = image.toJPEG(attempt < 2 ? 88 - attempt * 10 : 74);
    if (output.length <= 2 * 1024 * 1024) return 'data:image/jpeg;base64,' + output.toString('base64');
    if (attempt >= 1) image = image.resize({width: Math.max(1, Math.floor(image.getSize().width * .8))});
  }
  throw new Error('图片仍然过大，请换一张 / This image is still too large. Choose another.');
}
module.exports = { inspectImage, prepareImage };
