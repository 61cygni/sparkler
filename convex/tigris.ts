"use node";

import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { RegisteredAction } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import {
  getViewerSubjectAction,
  requireApprovedViewerSubjectAction,
  requireViewerSubjectAction,
} from "./auth";

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

function audioStorageKey(
  sceneId: Id<"scenes">,
  kind: "background" | "positional",
  filename: string,
  audioId?: string,
) {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "bin";
  if (kind === "background") {
    return `audio/${sceneId}/background.${ext}`;
  }
  return `audio/${sceneId}/positional/${audioId ?? crypto.randomUUID()}.${ext}`;
}

function validateAudioUpload(filename: string, byteSize: number | undefined) {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : null;
  if (!ext || !["mp3", "wav", "ogg"].includes(ext)) {
    throw new Error("Audio must be .mp3, .wav, or .ogg");
  }
  const maxBytes = Number(process.env.SPARKLER_MAX_AUDIO_BYTES ?? 52_428_800);
  if (byteSize !== undefined && byteSize > maxBytes) {
    throw new Error(`Audio file too large (max ${maxBytes} bytes).`);
  }
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
    const subject = await requireApprovedViewerSubjectAction(ctx);
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
    const subject = await requireApprovedViewerSubjectAction(ctx);
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

export const presignAudioUpload = action({
  args: {
    sceneId: v.id("scenes"),
    filename: v.string(),
    kind: v.union(v.literal("background"), v.literal("positional")),
    audioId: v.optional(v.string()),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (
    ctx: ActionCtx,
    args: {
      sceneId: Id<"scenes">;
      filename: string;
      kind: "background" | "positional";
      audioId?: string;
      contentType?: string;
      byteSize?: number;
    },
  ) => {
    const subject = await requireApprovedViewerSubjectAction(ctx);
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== subject) {
      throw new Error("Forbidden");
    }
    validateAudioUpload(args.filename, args.byteSize);

    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    const contentType = args.contentType ?? "application/octet-stream";
    const storageKey = audioStorageKey(args.sceneId, args.kind, args.filename, args.audioId);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      ContentType: contentType,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 900 });
    return { url, headers: { "Content-Type": contentType }, storageKey };
  },
} as never) as RegisteredAction<
  "public",
  {
    sceneId: Id<"scenes">;
    filename: string;
    kind: "background" | "positional";
    audioId?: string;
    contentType?: string;
    byteSize?: number;
  },
  Promise<{ url: string; headers: { "Content-Type": string }; storageKey: string }>
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
    const subject = await requireApprovedViewerSubjectAction(ctx);
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

export const resolveSceneAudio = action({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx: ActionCtx, args: { sceneId: Id<"scenes"> }) => {
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.visibility === "private") {
      const subject = await requireViewerSubjectAction(ctx);
      if (scene.ownerSubject !== subject) {
        throw new Error("Forbidden");
      }
    }

    const background = scene.audio?.background ?? null;
    const positional = scene.audio?.positional ?? [];
    if (!background && positional.length === 0) {
      return null;
    }

    const publicBase = process.env.TIGRIS_PUBLIC_BASE_URL?.replace(/\/$/, "");
    const usePublic =
      Boolean(publicBase) &&
      (scene.visibility === "public" || scene.visibility === "unlisted");

    if (usePublic && publicBase) {
      return {
        background: background ? { ...background, url: `${publicBase}/${background.storageKey}` } : null,
        positional: positional.map((item) => ({
          ...item,
          url: `${publicBase}/${item.storageKey}`,
        })),
      };
    }

    const { bucket } = requireTigrisEnv();
    const client = s3Client();
    const backgroundUrl = background
      ? await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: background.storageKey }),
          { expiresIn: 3600 },
        )
      : null;
    const positionalUrls = await Promise.all(
      positional.map(async (item) => ({
        ...item,
        url: await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: item.storageKey }),
          { expiresIn: 3600 },
        ),
      })),
    );

    return {
      background: background ? { ...background, url: backgroundUrl } : null,
      positional: positionalUrls,
    };
  },
} as never) as RegisteredAction<
  "public",
  { sceneId: Id<"scenes"> },
  Promise<
    | null
    | {
        background:
          | null
          | {
              storageKey: string;
              filename: string;
              contentType: string;
              byteSize: number;
              volume?: number;
              loop?: boolean;
              url: string;
            };
        positional: Array<{
          id: string;
          storageKey: string;
          filename: string;
          contentType: string;
          byteSize: number;
          position: number[];
          volume?: number;
          loop?: boolean;
          refDistance?: number;
          maxDistance?: number;
          rolloffFactor?: number;
          url: string;
        }>;
      }
  >
>;
