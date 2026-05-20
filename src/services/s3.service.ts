import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { getS3, s3Bucket } from '../config/s3';

export function knowledgeKey(workspaceId: string, campaignId: string, fileName: string): string {
  // Per spec:
  //   workspaces/{workspace_id}/campaigns/{campaign_id}/knowledge/original/{file_name}
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `workspaces/${workspaceId}/campaigns/${campaignId}/knowledge/original/${safeName}`;
}

export async function putObject(input: {
  key: string;
  body: Buffer | Readable;
  contentType?: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  const params: PutObjectCommandInput = {
    Bucket: s3Bucket(),
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    Metadata: input.metadata,
  };
  await getS3().send(new PutObjectCommand(params));
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await getS3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }));
  if (!res.Body) throw new Error(`S3 object empty: ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }));
}

/** Presigned URL for short-lived downloads. Default 15 minutes. */
export async function presignDownload(key: string, expiresSeconds = 900): Promise<string> {
  return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: s3Bucket(), Key: key }), {
    expiresIn: expiresSeconds,
  });
}

export function s3UriFor(key: string): string {
  return `s3://${s3Bucket()}/${key}`;
}
