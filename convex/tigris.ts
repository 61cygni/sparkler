"use node";

import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { RegisteredAction } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { getViewerSubjectAction, requireViewerSubjectAction } from "./auth";

function requireTigrisEnv() {
  const accessKeyId = process.env.TIGRIS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TIGRIS_SECRET_ACCESS_KEY;
  const bucket = process.env.TIGRIS_BUCKET;
  const endpoint = process.env.TIGRIS_ENDPOINT;
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new Error(
      "Missing Tigris env: TIGRIS_ACCESS_KEY_ID, TIGRIS_SECRET_ACCESS_KEY, TIGRIS_BUCKET, TIGRIS_ENDPOINT",
    );
  }
  return { accessKeyId, secretAccessKey, bucket, endpoint };
}

function s3Client() {
  const { accessKeyId, secretAccessKey, endpoint } = requireTigrisEnv();
  return new S3Client({
    region: process.env.TIGRIS_REGION ?? "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

function thumbnailStorageKey(sceneId: Id<"scenes">): string {
  return `thumbnails/${sceneId}.jpg`;
}

export const presignUpload = action({
  args: {
    sceneId: v.id("scenes"),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (
    ctx: ActionCtx,
    args: { sceneId: Id<"scenes">; contentType?: string; byteSize?: number },
  ) => {
    const subject = await requireViewerSubjectAction(ctx);
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== subject) {
      throw new Error("Forbidden");
    }
    if (scene.status !== "pending_upload") {
      throw new Error("Invalid scene status for upload");
    }

    const maxBytes = Number(process.env.SPARKLER_MAX_UPLOAD_BYTES ?? 536870912);
    if (args.byteSize !== undefined && args.byteSize > maxBytes) {
      throw new Error(`File too large (max ${maxBytes} bytes).`);
    }

    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    const contentType = args.contentType ?? "application/octet-stream";

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: scene.storageKey,
      ContentType: contentType,
    });

    const url = await getSignedUrl(client, command, { expiresIn: 900 });
    return { url, headers: { "Content-Type": contentType } };
  },
} as never) as RegisteredAction<
  "public",
  { sceneId: Id<"scenes">; contentType?: string; byteSize?: number },
  Promise<{ url: string; headers: { "Content-Type": string } }>
>;

export const presignView = action({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx: ActionCtx, args: { sceneId: Id<"scenes"> }) => {
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene || scene.status !== "ready") {
      throw new Error("Scene not available");
    }

    if (scene.visibility === "private") {
      const subject = await requireViewerSubjectAction(ctx);
      if (scene.ownerSubject !== subject) {
        throw new Error("Forbidden");
      }
    }

    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: scene.storageKey,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 3600 });
    return { url };
  },
} as never) as RegisteredAction<
  "public",
  { sceneId: import("./_generated/dataModel").Id<"scenes"> },
  Promise<{ url: string }>
>;

export const presignThumbnailUpload = action({
  args: {
    sceneId: v.id("scenes"),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (
    ctx: ActionCtx,
    args: { sceneId: Id<"scenes">; contentType?: string; byteSize?: number },
  ) => {
    const subject = await requireViewerSubjectAction(ctx);
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== subject) {
      throw new Error("Forbidden");
    }
    if (scene.status !== "ready") {
      throw new Error("Scene must be ready before uploading a thumbnail");
    }

    const contentType = args.contentType ?? "image/jpeg";
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error("Thumbnail must be JPEG, PNG, or WebP");
    }
    const maxThumbBytes = Number(process.env.SPARKLER_MAX_THUMBNAIL_BYTES ?? 5_242_880);
    if (args.byteSize !== undefined && args.byteSize > maxThumbBytes) {
      throw new Error(`Thumbnail too large (max ${maxThumbBytes} bytes).`);
    }

    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: thumbnailStorageKey(args.sceneId),
      ContentType: contentType,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 900 });
    return { url, headers: { "Content-Type": contentType } };
  },
} as never) as RegisteredAction<
  "public",
  { sceneId: Id<"scenes">; contentType?: string; byteSize?: number },
  Promise<{ url: string; headers: { "Content-Type": string } }>
>;

export const presignThumbnailUrls = action({
  args: {
    sceneIds: v.array(v.id("scenes")),
  },
  handler: async (ctx: ActionCtx, args: { sceneIds: Id<"scenes">[] }) => {
    if (args.sceneIds.length > 100) {
      throw new Error("Too many sceneIds; max 100");
    }
    const viewerSubject = await getViewerSubjectAction(ctx);
    const scenes = await Promise.all(
      args.sceneIds.map((sceneId) =>
        ctx.runQuery(internal.sceneInternals.get, {
          sceneId,
        }),
      ),
    );
    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    const results: Array<{ sceneId: Id<"scenes">; url: string }> = [];

    for (let i = 0; i < args.sceneIds.length; i += 1) {
      const sceneId = args.sceneIds[i];
      const scene = scenes[i];
      if (!scene?.thumbnail) {
        continue;
      }
      if (scene.visibility === "private" && scene.ownerSubject !== viewerSubject) {
        continue;
      }

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: scene.thumbnail.storageKey,
      });
      const url = await getSignedUrl(client, command, { expiresIn: 3600 });
      results.push({ sceneId, url });
    }

    return results;
  },
} as never) as RegisteredAction<
  "public",
  { sceneIds: Id<"scenes">[] },
  Promise<Array<{ sceneId: Id<"scenes">; url: string }>>
>;

/**
 * Optional: verify object exists after PUT (call from client after upload).
 */
export const verifyObject = action({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx: ActionCtx, args: { sceneId: Id<"scenes"> }) => {
    const subject = await requireViewerSubjectAction(ctx);
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene || scene.ownerSubject !== subject) {
      throw new Error("Forbidden");
    }
    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: scene.storageKey }),
    );
    return { ok: true as const };
  },
} as never) as RegisteredAction<
  "public",
  { sceneId: import("./_generated/dataModel").Id<"scenes"> },
  Promise<{ ok: true }>
>;
