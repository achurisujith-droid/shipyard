import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { requireOrg } from '@/components/organization_tenancy/tenancy';
import { isAllowedSize, isAllowedType, safeDisplayName, storageKey, MAX_BYTES } from '@/components/s3_file_storage/keys';
import { isStorageConfigured, uploadUrl } from '@/components/s3_file_storage/storage';

/**
 * `POST /api/files/upload-url` — ask for permission to upload.
 *
 * The browser sends what it wants to upload; this decides whether that is
 * allowed and hands back a short-lived link. Every check happens here, because
 * once the link is issued the storage provider will accept whatever it is given
 * within the terms that were signed.
 */

const Body = z.object({
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive(),
});

export async function POST(request: NextRequest) {
  const org = await requireOrg();
  if (!org.ok) return org.response;

  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'File storage is not set up yet.' }, { status: 503 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please check the file details.' }, { status: 400 });
  }

  if (!isAllowedType(parsed.data.contentType)) {
    return NextResponse.json({ error: 'That kind of file is not accepted.' }, { status: 415 });
  }
  if (!isAllowedSize(parsed.data.sizeBytes)) {
    return NextResponse.json(
      { error: `Files have to be smaller than ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.` },
      { status: 413 },
    );
  }

  const key = storageKey({
    organizationId: org.context.organizationId,
    contentType: parsed.data.contentType,
  });

  const record = await prisma.storedFile.create({
    data: {
      organizationId: org.context.organizationId,
      key,
      displayName: safeDisplayName(parsed.data.filename),
      contentType: parsed.data.contentType,
      sizeBytes: parsed.data.sizeBytes,
      uploadedBy: org.context.userId,
    },
    select: { id: true, displayName: true },
  });

  return NextResponse.json({
    fileId: record.id,
    displayName: record.displayName,
    url: await uploadUrl({
      key,
      contentType: parsed.data.contentType,
      contentLength: parsed.data.sizeBytes,
    }),
    expiresInSeconds: 300,
  });
}
