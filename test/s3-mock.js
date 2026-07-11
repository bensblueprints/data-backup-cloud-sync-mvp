// Minimal in-memory S3-compatible fixture server for smoke tests.
// Path-style only: /<bucket>/<key>. Supports PutObject, GetObject,
// HeadObject, DeleteObject and ListObjectsV2 — just enough for the
// @aws-sdk/client-s3 calls Syncvault makes. NO live network involved.
const http = require('node:http');

function createS3Mock() {
  const store = new Map(); // "bucket/key" -> Buffer

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    const bucket = parts.shift() || '';
    const key = decodeURIComponent(parts.join('/'));
    const id = `${bucket}/${key}`;

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        store.set(id, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"mock"' });
        res.end();
      });
      return;
    }

    if (req.method === 'HEAD') {
      const buf = store.get(id);
      if (!buf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Length': buf.length, ETag: '"mock"' });
      return res.end();
    }

    if (req.method === 'GET' && key === '' && url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(bucket + '/'))
        .map((k) => k.slice(bucket.length + 1))
        .filter((k) => k.startsWith(prefix))
        .sort();
      const xmlKeys = keys.map((k) =>
        `<Contents><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Key><Size>${store.get(bucket + '/' + k).length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"mock"</ETag></Contents>`
      ).join('');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount>
<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${xmlKeys}</ListBucketResult>`;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(xml);
    }

    if (req.method === 'GET') {
      const buf = store.get(id);
      if (!buf) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
      }
      res.writeHead(200, { 'Content-Length': buf.length });
      return res.end(buf);
    }

    if (req.method === 'DELETE') {
      store.delete(id);
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(400);
    res.end();
  });

  return {
    server,
    store,
    listen(port) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    close() {
      return new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    }
  };
}

module.exports = { createS3Mock };
