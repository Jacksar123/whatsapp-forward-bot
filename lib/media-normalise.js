const { fileTypeFromBuffer } = require('file-type');
const sharp = require('sharp');

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Ensures the buffer is WA-acceptable. Converts non-accepted types to JPEG.
 */
async function normaliseImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid image buffer');
  }

  const type = await fileTypeFromBuffer(buffer);
  const mime = type?.mime || 'application/octet-stream';

  if (!ACCEPTED.has(mime)) {
    const converted = await sharp(buffer).jpeg({ quality: 88 }).toBuffer();
    return { buffer: converted, mimetype: 'image/jpeg' };
  }

  return { buffer, mimetype: mime };
}

module.exports = { normaliseImage };
