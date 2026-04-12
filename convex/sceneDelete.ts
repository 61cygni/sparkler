"use node";

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { RegisteredAction } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction } from "./_generated/server";
import { requireViewerSubjectAction } from "./auth";

function cliOwnerSubject(): string {
  const owner = process.env.SPARKLER_CLI_OWNER_SUBJECT?.trim();
  if (!owner) {
    throw new Error("SPARKLER_CLI_OWNER_SUBJECT not set");
  }
  return owner;
}

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

async function deleteSceneForOwner(
  ctx: ActionCtx,
  sceneId: Id<"scenes">,
  ownerSubject: string,
) {
  const scene = await ctx.runQuery(internal.sceneInternals.get, {
    sceneId,
  });
  if (!scene || scene.ownerSubject !== ownerSubject) {
    throw new Error("Not found or forbidden");
  }

  const { bucket } = requireTigrisEnv();
  const client = s3Client();
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: scene.storageKey }),
  );
  if (scene.thumbnail?.storageKey) {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: scene.thumbnail.storageKey }),
    );
  }

  await ctx.runMutation(internal.scenes.removeSceneDocument, {
    sceneId,
    ownerSubject,
  });
  return { ok: true as const };
}

/** Deletes the object in Tigris (best effort) and removes the scenes row. */
export const deleteMyScene = action({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx: ActionCtx, args: { sceneId: Id<"scenes"> }) => {
    const subject = await requireViewerSubjectAction(ctx);
    return await deleteSceneForOwner(ctx, args.sceneId, subject);
  },
} as never) as RegisteredAction<
  "public",
  { sceneId: Id<"scenes"> },
  Promise<{ ok: true }>
>;

export const deleteForCli = internalAction({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx: ActionCtx, args: { sceneId: Id<"scenes"> }) => {
    return await deleteSceneForOwner(ctx, args.sceneId, cliOwnerSubject());
  },
} as never);
