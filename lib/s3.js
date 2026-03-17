/**
 * Amazon S3 helper module.
 *
 * Centralises all S3 operations for prototype and asset storage.
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { Readable } = require('stream');

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.AWS_REGION || 'us-east-1';

const s3 = new S3Client({ region: REGION });

/**
 * Upload a file to S3.
 * @param {string} key — S3 object key (e.g. "prototypes/my-form.html")
 * @param {string|Buffer} body — file content
 * @param {string} contentType — MIME type
 * @returns {Promise<void>}
 */
async function putObject(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

/**
 * Get a file from S3.
 * @param {string} key — S3 object key
 * @returns {Promise<{body: Readable, contentType: string, contentLength: number}>}
 * @throws {Error} if key does not exist (NoSuchKey)
 */
async function getObject(key) {
  const resp = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
  return {
    body: resp.Body,
    contentType: resp.ContentType,
    contentLength: resp.ContentLength,
  };
}

/**
 * Get a partial range of a file from S3.
 * @param {string} key — S3 object key
 * @param {number} start — byte offset start
 * @param {number} end — byte offset end (inclusive)
 * @returns {Promise<string>} — text content of the range
 */
async function getObjectRange(key, start, end) {
  const resp = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Range: `bytes=${start}-${end}`,
  }));
  return await resp.Body.transformToString('utf-8');
}

/**
 * List objects in S3 with a given prefix.
 * @param {string} prefix — key prefix (e.g. "prototypes/")
 * @returns {Promise<Array<{key: string, size: number, lastModified: Date}>>}
 */
async function listObjects(prefix) {
  const result = [];
  let continuationToken;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    if (resp.Contents) {
      for (const obj of resp.Contents) {
        result.push({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      }
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  return result;
}

/**
 * Get metadata for an S3 object.
 * @param {string} key — S3 object key
 * @returns {Promise<{size: number, lastModified: Date, contentType: string}>}
 */
async function headObject(key) {
  const resp = await s3.send(new HeadObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
  return {
    size: resp.ContentLength,
    lastModified: resp.LastModified,
    contentType: resp.ContentType,
  };
}

module.exports = { putObject, getObject, getObjectRange, listObjects, headObject };
