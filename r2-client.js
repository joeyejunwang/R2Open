/**
 * r2-client.js – Cloudflare R2 client (main process)
 *
 * Uses the official AWS SDK for JavaScript v3 (@aws-sdk/client-s3) in
 * S3-compatible mode.  Cloudflare R2 exposes an S3-compatible API, so
 * the SDK handles SigV4, header canonicalisation, payload hashing and
 * endpoint derivation for us.  This is a much smaller and far more
 * reliable surface than hand-rolling the signing process.
 *
 * Public entry points:
 *   listBuckets(cfg)              -> { buckets, owner }
 *   listObjects(cfg, bucket, pfx) -> { prefix, objects, commonPrefixes, isTruncated, nextContinuationToken }
 *   cfg = { accountId, accessKeyId, secretAccessKey, endpoint? }
 */

const {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

/**
 * Build an S3Client pointed at Cloudflare R2.
 *
 * R2 specifics baked in here:
 *   - region is always "auto" (R2 ignores it but SigV4 still expects it)
 *   - the endpoint follows the pattern
 *     https://<accountId>.r2.cloudflarestorage.com unless overridden
 */
function makeClient(cfg) {
  if (!cfg || !cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('Missing R2 credentials');
  }
  const endpoint =
    (cfg.endpoint && cfg.endpoint.replace(/\/+$/, '')) ||
    `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // R2 returns the wrong region in some responses; forceSignatureVersion
    // is unnecessary here because the SDK signs with SigV4 by default.
  });
}

/**
 * Convert an AWS SDK error into a plain Error with helpful attached fields
 * so the renderer can show status / code without needing to walk the SDK's
 * nested error shape.
 */
function wrapError(err) {
  const name = err && err.name;
  const message = (err && err.message) || String(err);
  const out = new Error(message);
  // `$metadata` is set on most service exceptions.
  if (err && err.$metadata && err.$metadata.httpStatusCode) {
    out.status = err.$metadata.httpStatusCode;
  }
  if (name) out.code = name;
  return out;
}

/**
 * List every bucket in the account.
 *
 * @param {object} cfg - { accountId, accessKeyId, secretAccessKey, endpoint? }
 * @returns {Promise<{buckets:Array, owner:object|null}>}
 */
async function listBuckets(cfg) {
  const client = makeClient(cfg);
  try {
    const res = await client.send(new ListBucketsCommand({}));
    const owner = res.Owner
      ? { id: res.Owner.ID || null, displayName: res.Owner.DisplayName || null }
      : null;
    const buckets = (res.Buckets || []).map((b) => ({
      name: b.Name,
      creationDate: b.CreationDate ? b.CreationDate.toISOString() : null,
    }));
    return { buckets, owner };
  } catch (err) {
    throw wrapError(err);
  } finally {
    // The SDK keeps an HTTPS keep-alive agent alive.  Destroying the
    // client prevents socket leaks when the user re-opens settings.
    client.destroy();
  }
}

/**
 * List objects in a bucket.  Returns a flat array of objects plus
 * common prefixes (pseudo-folders).
 *
 * @param {object} cfg       - { accountId, accessKeyId, secretAccessKey, endpoint? }
 * @param {string} bucket    - bucket name
 * @param {string} [prefix]  - optional key prefix (folder)
 * @param {number} [maxKeys] - cap on returned keys; defaults to 1000
 * @returns {Promise<{prefix:string, objects:Array, commonPrefixes:Array, isTruncated:boolean, nextContinuationToken:string|null}>}
 */
async function listObjects(cfg, bucket, prefix = '', maxKeys = 1000, continuationToken = null) {
  if (!bucket) throw new Error('Bucket name is required');
  const client = makeClient(cfg);
  try {
    const params = {
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
      Delimiter: '/',
    };
    if (continuationToken) params.ContinuationToken = continuationToken;
    const res = await client.send(new ListObjectsV2Command(params));
    const objects = (res.Contents || []).map((o) => ({
      key: o.Key,
      size: o.Size ?? 0,
      lastModified: o.LastModified ? o.LastModified.toISOString() : null,
      etag: o.ETag || null,
      isFolder: false,
    }));
    const commonPrefixes = (res.CommonPrefixes || []).map((p) => p.Prefix).filter(Boolean);
    return {
      prefix: res.Prefix || prefix,
      objects,
      commonPrefixes,
      isTruncated: !!res.IsTruncated,
      nextContinuationToken: res.NextContinuationToken || null,
    };
  } catch (err) {
    throw wrapError(err);
  } finally {
    client.destroy();
  }
}

/**
 * Compute bucket statistics by walking the whole object tree.
 *
 * R2 does NOT expose per-bucket storage metrics over the S3 API (those
 * live in the Cloudflare dashboard).  What we CAN compute here is the
 * accurate object count, byte total, folder count and a breakdown by
 * top-level prefix.  We do this by paginating ListObjectsV2 with
 * Delimiter='/' and summing across pages until IsTruncated is false.
 *
 * @param {object} cfg    - { accountId, accessKeyId, secretAccessKey, endpoint? }
 * @param {string} bucket - bucket name
 * @param {object} [opts] - { pageSize?, maxPages?, prefixDepth? }
 *   prefixDepth: how deep to slice for top-level breakdown (default 1 → "a/", "b/")
 * @returns {Promise<{
 *   bucket:string,
 *   totalObjects:number,
 *   totalFolders:number,
 *   totalBytes:number,
 *   scannedKeys:number,
 *   isTruncated:boolean,
 *   pages:number,
 *   topLevelPrefixes: Array<{prefix:string, objectCount:number, folderCount:number, bytes:number}>,
 *   largestObjects: Array<{key:string, size:number, lastModified:string|null}>,
 * }>}
 */
async function getBucketStats(cfg, bucket, opts = {}) {
  if (!bucket) throw new Error('Bucket name is required');
  const pageSize   = Math.min(Math.max(opts.pageSize   || 1000, 100), 1000);
  const maxPages   = Math.min(Math.max(opts.maxPages   || 200,   1),   10000);
  const prefixDepth = Math.max(opts.prefixDepth || 1, 1);

  const client = makeClient(cfg);
  let token = null;
  let pages = 0;
  let totalObjects = 0;
  let totalFolders = 0;
  let totalBytes = 0;
  let scannedKeys = 0;
  let isTruncated = false;
  const largestObjects = []; // bounded to top 10 in render code

  // Aggregations
  const topMap = new Map(); // prefix -> { objectCount, folderCount, bytes }

  function recordPrefix(seg) {
    // seg is a top-level folder like "a/" or "a/b/" depending on prefixDepth
    let key = seg;
    for (let i = 0; i < prefixDepth - 1; i++) {
      const next = key.indexOf('/', key.indexOf('/') + 1);
      if (next < 0) { key = seg; break; }
      key = seg.slice(0, next + 1);
    }
    const cur = topMap.get(key) || { prefix: key, objectCount: 0, folderCount: 0, bytes: 0 };
    topMap.set(key, cur);
    return cur;
  }

  try {
    while (pages < maxPages) {
      const res = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Delimiter: '/',
        MaxKeys: pageSize,
        ContinuationToken: token || undefined,
      }));

      pages += 1;
      scannedKeys += (res.KeyCount || 0);

      for (const cp of res.CommonPrefixes || []) {
        if (!cp.Prefix) continue;
        totalFolders += 1;
        const slot = recordPrefix(cp.Prefix);
        slot.folderCount += 1;
      }

      for (const o of res.Contents || []) {
        if (!o.Key) continue;
        // Skip the zero-byte "directory placeholder" that S3-compatible
        // stores sometimes return for an otherwise empty prefix.
        if (o.Key.endsWith('/') && (o.Size ?? 0) === 0) continue;
        totalObjects += 1;
        totalBytes   += o.Size ?? 0;

        // Bucket by top-level prefix (everything before the first '/').
        const slash = o.Key.indexOf('/');
        if (slash > 0) {
          const slot = recordPrefix(o.Key.slice(0, slash + 1));
          slot.objectCount += 1;
          slot.bytes       += o.Size ?? 0;
        }

        // Track top-N largest.
        largestObjects.push({
          key: o.Key,
          size: o.Size ?? 0,
          lastModified: o.LastModified ? o.LastModified.toISOString() : null,
        });
        largestObjects.sort((a, b) => b.size - a.size);
        if (largestObjects.length > 10) largestObjects.length = 10;
      }

      isTruncated = !!res.IsTruncated;
      token = res.NextContinuationToken || null;
      if (!isTruncated || !token) break;
    }

    const topLevelPrefixes = Array.from(topMap.values())
      .sort((a, b) => b.bytes - a.bytes);

    return {
      bucket: bucket,
      totalObjects,
      totalFolders,
      totalBytes,
      scannedKeys,
      isTruncated,
      pages,
      topLevelPrefixes,
      largestObjects,
    };
  } catch (err) {
    throw wrapError(err);
  } finally {
    client.destroy();
  }
}

module.exports = { listBuckets, listObjects, getBucketStats, getObjectBytes, deleteObject, putObjectFromPath, putObjectFromBytes, existsSync };

/**
 * Upload raw bytes (Buffer / Uint8Array) to a bucket+key.
 *
 * @param {object} cfg
 * @param {string} bucket
 * @param {string} key
 * @param {Buffer|Uint8Array} body
 * @param {string} [contentType]
 * @returns {Promise<{etag:string|null, size:number, contentType:string}>}
 */
async function putObjectFromBytes(cfg, bucket, key, body, contentType) {
  if (!bucket) throw new Error('bucket is required');
  if (!key) throw new Error('key is required');
  if (!body) throw new Error('body is required');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const ct = contentType || guessContentType(key);
  const client = makeClient(cfg);
  try {
    const res = await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buf,
      ContentType: ct,
    }));
    return { etag: res && res.ETag, size: buf.length, contentType: ct };
  } catch (err) {
    throw wrapError(err);
  } finally {
    client.destroy();
  }
}

/**
 * Download a single object fully into a Buffer.
 * @returns { Buffer } raw bytes
 */
async function getObjectBytes(cfg, bucket, key) {
  if (!bucket) throw new Error('bucket is required');
  if (!key) throw new Error('key is required');
  const client = makeClient(cfg);
  try {
    const res = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    if (!res || !res.Body) throw new Error('Empty response body');
    // SDK v3 Body is a Node readable; convert to Buffer.
    const chunks = [];
    for await (const chunk of res.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    throw wrapError(err);
  } finally {
    client.destroy();
  }
}

/**
 * Delete a single object from a bucket.
 * @returns { Promise<void> }
 */
async function deleteObject(cfg, bucket, key) {
  if (!bucket) throw new Error('bucket is required');
  if (!key) throw new Error('key is required');
  const client = makeClient(cfg);
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
  } catch (err) {
    throw wrapError(err);
  } finally {
    client.destroy();
  }
}

/**
 * Upload a file from a local path to the bucket+key.
 * @returns { etag, size }
 */
async function putObjectFromPath(cfg, bucket, key, localPath) {
  if (!bucket) throw new Error('bucket is required');
  if (!key) throw new Error('key is required');
  if (!localPath) throw new Error('localPath is required');
  const fs = require('fs');
  const body = fs.readFileSync(localPath);
  const contentType = guessContentType(localPath);
  const client = makeClient(cfg);
  try {
    const res = await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    return { etag: res && res.ETag, size: body.length, contentType };
  } catch (err) {
    throw wrapError(err);
  } finally {
    client.destroy();
  }
}

/** Best-effort MIME guess from extension. Pure helper, never throws. */
function guessContentType(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  const map = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    js: 'application/javascript',
    ts: 'application/typescript',
    html: 'text/html',
    css: 'text/css',
    csv: 'text/csv',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  };
  return map[ext] || 'application/octet-stream';
}

/** Return true if a local path exists on disk. */
function existsSync(localPath) {
  try {
    return fs.existsSync(localPath);
  } catch {
    return false;
  }
}
