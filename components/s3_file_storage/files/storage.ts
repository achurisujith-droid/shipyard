import { GetObjectCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { MAX_BYTES } from '@/components/s3_file_storage/keys';

/**
 * Talking to the bucket.
 *
 * Uploads go straight from the browser to the storage provider using a signed
 * link, rather than through the app. That is not an optimisation — routing a
 * 25 MB upload through a Next.js route means holding it in memory on a server
 * sized for rendering pages, and it is how a handful of concurrent uploads
 * takes a small deployment down.
 */

let client: S3Client | null = null;

function s3(): S3Client {
  if (client) return client;
  const region = process.env.S3_REGION?.trim() || 'auto';
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('File storage is not configured: S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are missing.');
  }

  client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

function bucket(): string {
  const name = process.env.S3_BUCKET?.trim();
  if (!name) throw new Error('S3_BUCKET is not set, so there is nowhere to put files.');
  return name;
}

/** How long a signed link lasts. Short: it is a key, and links get forwarded. */
const UPLOAD_TTL_SECONDS = 5 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

export async function uploadUrl(input: { key: string; contentType: string; contentLength: number }) {
  if (input.contentLength > MAX_BYTES) throw new Error('That file is too big.');
  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: input.key,
    ContentType: input.contentType,
    // Signing the length stops someone using a link issued for a small file to
    // upload a very large one.
    ContentLength: input.contentLength,
  });
  return getSignedUrl(s3(), command, { expiresIn: UPLOAD_TTL_SECONDS });
}

export async function downloadUrl(input: { key: string; filename?: string }) {
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: input.key,
    ...(input.filename
      ? { ResponseContentDisposition: `attachment; filename="${input.filename.replace(/"/g, '')}"` }
      : {}),
  });
  return getSignedUrl(s3(), command, { expiresIn: DOWNLOAD_TTL_SECONDS });
}

export async function remove(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export function isStorageConfigured(): boolean {
  return Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}
