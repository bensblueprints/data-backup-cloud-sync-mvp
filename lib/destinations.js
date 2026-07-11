// Destination adapters: local directory + any S3-compatible endpoint
// (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO).
// Interface: test(), putFile(localPath, key), exists(key), downloadTo(key, localPath), remove(key), list(prefix)
const fs = require('fs');
const path = require('path');

function createAdapter(dest) {
  const config = typeof dest.config_json === 'string' ? JSON.parse(dest.config_json || '{}') : (dest.config_json || {});
  if (dest.type === 'local') return localAdapter(config);
  if (dest.type === 's3') return s3Adapter(config);
  throw new Error(`Unknown destination type: ${dest.type}`);
}

/* ---------------- local directory ---------------- */

function localAdapter(config) {
  const dir = config.path;
  if (!dir) throw new Error('Local destination has no path configured');
  const full = (key) => path.join(dir, key.replace(/\//g, path.sep));
  return {
    async test() {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.sv-probe-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { ok: true, detail: `Writable: ${dir}` };
    },
    async putFile(localPath, key) {
      fs.mkdirSync(path.dirname(full(key)), { recursive: true });
      fs.copyFileSync(localPath, full(key));
    },
    async exists(key) {
      return fs.existsSync(full(key));
    },
    async downloadTo(key, localPath) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.copyFileSync(full(key), localPath);
    },
    async remove(key) {
      fs.rmSync(full(key), { force: true });
    },
    async list(prefix) {
      const base = full(prefix);
      const root = fs.existsSync(base) && fs.statSync(base).isDirectory() ? base : path.dirname(base);
      if (!fs.existsSync(root)) return [];
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            const key = path.relative(dir, p).split(path.sep).join('/');
            if (key.startsWith(prefix)) out.push({ key, size: fs.statSync(p).size });
          }
        }
      };
      walk(root);
      return out;
    }
  };
}

/* ---------------- S3-compatible ---------------- */

function s3Adapter(config) {
  const { endpoint, region, bucket, prefix = '', accessKeyId, secretAccessKey, forcePathStyle } = config;
  if (!bucket) throw new Error('S3 destination has no bucket configured');
  const k = (key) => (prefix ? `${prefix.replace(/\/+$/, '')}/${key}` : key);

  function client() {
    const { S3Client } = require('@aws-sdk/client-s3');
    return new S3Client({
      region: region || 'us-east-1',
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: forcePathStyle !== false && !!endpoint,
      credentials: { accessKeyId: accessKeyId || '', secretAccessKey: secretAccessKey || '' }
    });
  }

  return {
    async test() {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      await client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, MaxKeys: 1 }));
      return { ok: true, detail: `Bucket reachable: ${bucket}` };
    },
    async putFile(localPath, key) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      // Buffer body (objects are per-file, encrypted) — avoids aws-chunked
      // streaming encodings that some S3-compatible stores reject.
      const body = fs.readFileSync(localPath);
      await client().send(new PutObjectCommand({ Bucket: bucket, Key: k(key), Body: body, ContentLength: body.length }));
    },
    async exists(key) {
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      try {
        await client().send(new HeadObjectCommand({ Bucket: bucket, Key: k(key) }));
        return true;
      } catch (e) {
        if (e.$metadata && (e.$metadata.httpStatusCode === 404 || e.$metadata.httpStatusCode === 403)) return false;
        if (e.name === 'NotFound' || e.name === 'NoSuchKey') return false;
        throw e;
      }
    },
    async downloadTo(key, localPath) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const { pipeline } = require('stream/promises');
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }));
      await pipeline(res.Body, fs.createWriteStream(localPath));
    },
    async remove(key) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
    },
    async list(listPrefix) {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const c = client();
      const out = [];
      let ContinuationToken;
      do {
        const res = await c.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: k(listPrefix), ContinuationToken }));
        for (const obj of res.Contents || []) out.push({ key: prefix ? obj.Key.slice(prefix.length + 1) : obj.Key, size: obj.Size });
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    }
  };
}

module.exports = { createAdapter };
