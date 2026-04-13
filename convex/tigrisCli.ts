"use node";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";

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

/** Presign PUT for CLI HTTP flow (Bearer SPARKLER_CLI_SECRET). */
export const presignUploadForCli = internalAction({
  args: {
    sceneId: v.id("scenes"),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (
    ctx: ActionCtx,
    args: { sceneId: Id<"scenes">; contentType?: string; byteSize?: number },
  ) => {
    const owner = process.env.SPARKLER_CLI_OWNER_SUBJECT?.trim();
    if (!owner) {
      throw new Error("SPARKLER_CLI_OWNER_SUBJECT not set");
    }
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== owner) {
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
} as never);

export const presignUploadForOwner = internalAction({
  args: {
    ownerSubject: v.string(),
    sceneId: v.id("scenes"),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (
    ctx: ActionCtx,
    args: {
      ownerSubject: string;
      sceneId: Id<"scenes">;
      contentType?: string;
      byteSize?: number;
    },
  ) => {
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== args.ownerSubject) {
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
} as never);

export const presignAudioUploadForCli = internalAction({
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
    const owner = process.env.SPARKLER_CLI_OWNER_SUBJECT?.trim();
    if (!owner) {
      throw new Error("SPARKLER_CLI_OWNER_SUBJECT not set");
    }
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== owner) {
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
} as never);

export const presignAudioUploadForOwner = internalAction({
  args: {
    ownerSubject: v.string(),
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
      ownerSubject: string;
      sceneId: Id<"scenes">;
      filename: string;
      kind: "background" | "positional";
      audioId?: string;
      contentType?: string;
      byteSize?: number;
    },
  ) => {
    const scene = await ctx.runQuery(internal.sceneInternals.get, {
      sceneId: args.sceneId,
    });
    if (!scene) {
      throw new Error("Scene not found");
    }
    if (scene.ownerSubject !== args.ownerSubject) {
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
} as never);
