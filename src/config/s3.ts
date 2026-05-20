import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env';

let client: S3Client | null = null;

export function getS3(): S3Client {
  if (client) return client;
  const e = env();
  client = new S3Client({ region: e.AWS_REGION });
  return client;
}

export function s3Bucket(): string {
  return env().S3_BUCKET;
}
