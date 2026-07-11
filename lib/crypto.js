// SV1 encrypted-object format (client-side AES-256-GCM, key never leaves the box).
//
//   bytes 0..2    magic "SV1"
//   bytes 3..18   salt (16 bytes, random per object)
//   bytes 19..30  IV (12 bytes, random per object)
//   bytes 31..46  GCM auth tag (16 bytes)
//   bytes 47..    AES-256-GCM ciphertext of the file content
//
// Key derivation: scrypt(passphrase, salt, 32) with N=16384, r=8, p=1.
// Wrong passphrase → GCM auth failure (throws) — never silent garbage.
const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const SV1_MAGIC = Buffer.from('SV1');
const SV1_HEADER_LEN = 47;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function scryptKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT_PARAMS);
}

/** Encrypt a file to an SV1 object. Streams — no full buffering. */
async function encryptFile(srcPath, outPath, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = scryptKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = fs.createWriteStream(outPath);
  out.write(Buffer.concat([SV1_MAGIC, salt, iv, Buffer.alloc(16)]));
  await pipeline(fs.createReadStream(srcPath), cipher, out);

  const tag = cipher.getAuthTag();
  const fd = fs.openSync(outPath, 'r+');
  try {
    fs.writeSync(fd, tag, 0, 16, 31);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypt an SV1 object back to a plaintext file. Throws on wrong passphrase. */
async function decryptFile(inPath, outPath, passphrase) {
  const fd = fs.openSync(inPath, 'r');
  const header = Buffer.alloc(SV1_HEADER_LEN);
  try {
    fs.readSync(fd, header, 0, SV1_HEADER_LEN, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 3).equals(SV1_MAGIC)) {
    throw new Error('Not an SV1 encrypted object (bad magic)');
  }
  const salt = header.subarray(3, 19);
  const iv = header.subarray(19, 31);
  const tag = header.subarray(31, 47);
  const key = scryptKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(fs.createReadStream(inPath, { start: SV1_HEADER_LEN }), decipher, fs.createWriteStream(outPath));
}

/** sha256 hex digest of a file (streamed). */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

module.exports = { SV1_MAGIC, SV1_HEADER_LEN, encryptFile, decryptFile, sha256File, scryptKey };
