import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalQuery,
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import {
  getViewerSubject,
  requireAuthenticatedSubject,
  requireViewerSubject,
} from "./auth";

const defaultViewValidator = v.object({
  position: v.array(v.number()),
  target: v.array(v.number()),
  quaternion: v.optional(v.array(v.number())),
});

const visibilityValidator = v.union(
  v.literal("public"),
  v.literal("unlisted"),
  v.literal("private"),
);

const ALLOWED_EXT = new Set([
  "ply",
  "spz",
  "splat",
  "ksplat",
  "zip",
  "sog",
  "rad",
]);

function extensionFromFilename(name: string): string | null {
  const base = name.split(/[/\\]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  if (i < 0) return null;
  return base.slice(i + 1).toLowerCase();
}

function cliOwnerSubject(): string {
  const o = process.env.SPARKLER_CLI_OWNER_SUBJECT?.trim();
  if (!o) {
    throw new Error("SPARKLER_CLI_OWNER_SUBJECT is not set in Convex environment");
  }
  return o;
}

function demoOwnerSubject(): string {
  const subject = process.env.SPARKLER_DEMO_OWNER_SUBJECT?.trim();
  if (!subject) {
    throw new Error("SPARKLER_DEMO_OWNER_SUBJECT is not set in Convex environment");
  }
  return subject;
}

function thumbnailStorageKey(sceneId: Id<"scenes">): string {
  return `thumbnails/${sceneId}.jpg`;
}

async function updateSceneVisibilityForOwner(
  ctx: MutationCtx,
  sceneId: Id<"scenes">,
  ownerSubject: string,
  visibility: "public" | "unlisted" | "private",
) {
  const scene = await ctx.db.get(sceneId);
  if (!scene || scene.ownerSubject !== ownerSubject) {
    throw new Error("Forbidden");
  }
  await ctx.db.patch(sceneId, { visibility });
  return null;
}

async function insertPendingScene(
  ctx: MutationCtx,
  ownerSubject: string,
  args: {
    filename: string;
    title?: string;
    visibility: "public" | "unlisted" | "private";
    contentType?: string;
    byteSize?: number;
  },
) {
  const ext = extensionFromFilename(args.filename);
  if (!ext || !ALLOWED_EXT.has(ext)) {
    throw new Error(
      `Unsupported file type (.${ext ?? "none"}). Allowed: ${[...ALLOWED_EXT].join(", ")}`,
    );
  }
  const maxBytes = Number(process.env.SPARKLER_MAX_UPLOAD_BYTES ?? 536870912);
  if (args.byteSize !== undefined && args.byteSize > maxBytes) {
    throw new Error(`File too large (max ${maxBytes} bytes).`);
  }

  const storageKey = `splats/${crypto.randomUUID()}.${ext}`;
  const title =
    args.title?.trim() ||
    (args.filename.split(/[/\\]/).pop() ?? args.filename);

  const sceneId = await ctx.db.insert("scenes", {
    ownerSubject,
    title,
    visibility: args.visibility,
    storageKey,
    filename: args.filename,
    contentType: args.contentType,
    status: "pending_upload",
    createdAt: Date.now(),
  });

  return { sceneId, storageKey };
}

async function finalizePendingScene(
  ctx: MutationCtx,
  ownerSubject: string,
  args: {
    sceneId: Id<"scenes">;
    byteSize?: number;
    contentType?: string;
  },
) {
  const scene = await ctx.db.get(args.sceneId);
  if (!scene) {
    throw new Error("Scene not found");
  }
  if (scene.ownerSubject !== ownerSubject) {
    throw new Error("Forbidden");
  }
  if (scene.status !== "pending_upload") {
    throw new Error("Scene is not awaiting upload");
  }
  await ctx.db.patch(args.sceneId, {
    status: "ready",
    byteSize: args.byteSize,
    contentType: args.contentType ?? scene.contentType,
  });
  return null;
}

function canView(
  scene: {
    ownerSubject: string;
    visibility: "public" | "unlisted" | "private";
    status: "pending_upload" | "ready" | "failed";
  },
  viewerSubject: string | null,
): boolean {
  if (scene.visibility === "private") {
    return viewerSubject !== null && viewerSubject === scene.ownerSubject;
  }
  return true;
}

function resolveThumbnailAccess(scene: {
  _id: Id<"scenes">;
  visibility: "public" | "unlisted" | "private";
  thumbnail?: {
    storageKey: string;
    contentType: string;
    byteSize: number;
    width: number;
    height: number;
    updatedAt: number;
  };
}) {
  const thumbnail = scene.thumbnail ?? null;
  if (!thumbnail) {
    return {
      thumbnail: null,
      thumbnailUrl: null,
      needsSignedThumbnail: false,
    };
  }
  return {
    thumbnail,
    thumbnailUrl: null,
    needsSignedThumbnail: true,
  };
}

export const getScene = query({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx, args) => {
    const scene = await ctx.db.get(args.sceneId);
    if (!scene) {
      return null;
    }
    const viewer = await getViewerSubject(ctx);
    if (!canView(scene, viewer)) {
      return null;
    }

    const publicBase = process.env.TIGRIS_PUBLIC_BASE_URL?.replace(/\/$/, "");
    let splatUrl: string | null = null;
    if (
      scene.status === "ready" &&
      publicBase &&
      (scene.visibility === "public" || scene.visibility === "unlisted")
    ) {
      splatUrl = `${publicBase}/${scene.storageKey}`;
    }
    const isOwner = viewer !== null && viewer === scene.ownerSubject;
    const thumbnailAccess = resolveThumbnailAccess(scene);

    return {
      _id: scene._id,
      title: scene.title,
      visibility: scene.visibility,
      filename: scene.filename,
      status: scene.status,
      storageKey: scene.storageKey,
      createdAt: scene.createdAt,
      defaultView: scene.defaultView ?? null,
      isOwner,
      thumbnail: thumbnailAccess.thumbnail,
      thumbnailUrl: thumbnailAccess.thumbnailUrl,
      needsSignedThumbnail: thumbnailAccess.needsSignedThumbnail,
      splatUrl,
      needsSignedUrl:
        scene.status === "ready" &&
        (scene.visibility === "private" || !publicBase || splatUrl === null),
    };
  },
});

export const listPublicScenes = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 48, 100);
    const rows = await ctx.db
      .query("scenes")
      .withIndex("by_visibility_created", (q) => q.eq("visibility", "public"))
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "ready"))
      .take(limit);
    return rows.map((scene) => {
      const thumbnailAccess = resolveThumbnailAccess(scene);
      return {
        _id: scene._id,
        title: scene.title,
        filename: scene.filename,
        visibility: scene.visibility,
        status: scene.status,
        createdAt: scene.createdAt,
        thumbnail: thumbnailAccess.thumbnail,
        thumbnailUrl: thumbnailAccess.thumbnailUrl,
        needsSignedThumbnail: thumbnailAccess.needsSignedThumbnail,
      };
    });
  },
});

export const listMyScenes = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const subject = await getViewerSubject(ctx);
    if (!subject) {
      return [];
    }
    const limit = Math.min(args.limit ?? 100, 200);
    const rows = await ctx.db
      .query("scenes")
      .withIndex("by_owner_created", (q) => q.eq("ownerSubject", subject))
      .order("desc")
      .take(limit);
    return rows.map((scene) => {
      const thumbnailAccess = resolveThumbnailAccess(scene);
      return {
        _id: scene._id,
        title: scene.title,
        filename: scene.filename,
        visibility: scene.visibility,
        status: scene.status,
        createdAt: scene.createdAt,
        thumbnail: thumbnailAccess.thumbnail,
        thumbnailUrl: thumbnailAccess.thumbnailUrl,
        needsSignedThumbnail: thumbnailAccess.needsSignedThumbnail,
      };
    });
  },
});

export const listForCli = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 100, 200);
    return await ctx.db
      .query("scenes")
      .withIndex("by_owner_created", (q) => q.eq("ownerSubject", cliOwnerSubject()))
      .order("desc")
      .take(limit);
  },
});

export const createScene = mutation({
  args: {
    filename: v.string(),
    title: v.optional(v.string()),
    visibility: v.union(
      v.literal("public"),
      v.literal("unlisted"),
      v.literal("private"),
    ),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ownerSubject = await requireViewerSubject(ctx);
    return await insertPendingScene(ctx, ownerSubject, args);
  },
});

export const finalizeScene = mutation({
  args: {
    sceneId: v.id("scenes"),
    byteSize: v.optional(v.number()),
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ownerSubject = await requireViewerSubject(ctx);
    return await finalizePendingScene(ctx, ownerSubject, args);
  },
});

export const markSceneFailed = mutation({
  args: { sceneId: v.id("scenes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerSubject = await requireViewerSubject(ctx);
    const scene = await ctx.db.get(args.sceneId);
    if (!scene || scene.ownerSubject !== ownerSubject) {
      throw new Error("Forbidden");
    }
    await ctx.db.patch(args.sceneId, { status: "failed" });
    return null;
  },
});

export const updateSceneDefaultView = mutation({
  args: {
    sceneId: v.id("scenes"),
    defaultView: defaultViewValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerSubject = await requireViewerSubject(ctx);
    const scene = await ctx.db.get(args.sceneId);
    if (!scene || scene.ownerSubject !== ownerSubject) {
      throw new Error("Forbidden");
    }
    await ctx.db.patch(args.sceneId, {
      defaultView: args.defaultView,
    });
    return null;
  },
});

export const updateSceneVisibility = mutation({
  args: {
    sceneId: v.id("scenes"),
    visibility: visibilityValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerSubject = await requireViewerSubject(ctx);
    return await updateSceneVisibilityForOwner(
      ctx,
      args.sceneId,
      ownerSubject,
      args.visibility,
    );
  },
});

export const adoptDemoScenes = mutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({
    updated: v.number(),
    hasMore: v.boolean(),
    adoptedSubject: v.string(),
    demoSubject: v.string(),
  }),
  handler: async (ctx, args) => {
    const adoptedSubject = await requireAuthenticatedSubject(ctx);
    const demoSubject = demoOwnerSubject();
    if (adoptedSubject === demoSubject) {
      throw new Error("Authenticated subject already matches SPARKLER_DEMO_OWNER_SUBJECT");
    }

    const batchSize = Math.max(1, Math.min(args.batchSize ?? 200, 200));
    const rows = await ctx.db
      .query("scenes")
      .withIndex("by_owner_created", (q) => q.eq("ownerSubject", demoSubject))
      .order("desc")
      .take(batchSize);

    for (const row of rows) {
      await ctx.db.patch(row._id, {
        ownerSubject: adoptedSubject,
      });
    }

    return {
      updated: rows.length,
      hasMore: rows.length === batchSize,
      adoptedSubject,
      demoSubject,
    };
  },
});

export const saveSceneThumbnail = mutation({
  args: {
    sceneId: v.id("scenes"),
    contentType: v.string(),
    byteSize: v.number(),
    width: v.number(),
    height: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerSubject = await requireViewerSubject(ctx);
    const scene = await ctx.db.get(args.sceneId);
    if (!scene || scene.ownerSubject !== ownerSubject) {
      throw new Error("Forbidden");
    }
    if (scene.status !== "ready") {
      throw new Error("Scene must be ready before saving a thumbnail");
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(args.contentType)) {
      throw new Error("Thumbnail must be JPEG, PNG, or WebP");
    }
    if (!Number.isFinite(args.width) || !Number.isFinite(args.height)) {
      throw new Error("Thumbnail dimensions are invalid");
    }
    if (args.width < 1 || args.height < 1) {
      throw new Error("Thumbnail dimensions must be positive");
    }
    const maxThumbBytes = Number(process.env.SPARKLER_MAX_THUMBNAIL_BYTES ?? 5_242_880);
    if (args.byteSize > maxThumbBytes) {
      throw new Error(`Thumbnail too large (max ${maxThumbBytes} bytes).`);
    }

    await ctx.db.patch(args.sceneId, {
      thumbnail: {
        storageKey: thumbnailStorageKey(args.sceneId),
        contentType: args.contentType,
        byteSize: args.byteSize,
        width: Math.round(args.width),
        height: Math.round(args.height),
        updatedAt: Date.now(),
      },
    });
    return null;
  },
});

export const createForCli = internalMutation({
  args: {
    filename: v.string(),
    title: v.optional(v.string()),
    visibility: v.union(
      v.literal("public"),
      v.literal("unlisted"),
      v.literal("private"),
    ),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await insertPendingScene(ctx, cliOwnerSubject(), args);
  },
});

export const finalizeForCli = internalMutation({
  args: {
    sceneId: v.id("scenes"),
    byteSize: v.optional(v.number()),
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await finalizePendingScene(ctx, cliOwnerSubject(), args);
  },
});

export const markFailedForCli = internalMutation({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx, args) => {
    const ownerSubject = cliOwnerSubject();
    const scene = await ctx.db.get(args.sceneId);
    if (!scene || scene.ownerSubject !== ownerSubject) {
      throw new Error("Forbidden");
    }
    await ctx.db.patch(args.sceneId, { status: "failed" });
    return null;
  },
});

/** Called from deleteMyScene action after Tigris delete (or skip if key missing). */
export const removeSceneDocument = internalMutation({
  args: {
    sceneId: v.id("scenes"),
    ownerSubject: v.string(),
  },
  handler: async (ctx, args) => {
    const scene = await ctx.db.get(args.sceneId);
    if (!scene || scene.ownerSubject !== args.ownerSubject) {
      throw new Error("Forbidden");
    }
    await ctx.db.delete(args.sceneId);
    return null;
  },
});

export const updateDefaultViewForCli = internalMutation({
  args: {
    sceneId: v.id("scenes"),
    defaultView: defaultViewValidator,
  },
  handler: async (ctx, args) => {
    const ownerSubject = cliOwnerSubject();
    const scene = await ctx.db.get(args.sceneId);
    if (!scene || scene.ownerSubject !== ownerSubject) {
      throw new Error("Forbidden");
    }
    await ctx.db.patch(args.sceneId, {
      defaultView: args.defaultView,
    });
    return null;
  },
});

export const updateVisibilityForCli = internalMutation({
  args: {
    sceneId: v.id("scenes"),
    visibility: visibilityValidator,
  },
  handler: async (ctx, args) => {
    return await updateSceneVisibilityForOwner(
      ctx,
      args.sceneId,
      cliOwnerSubject(),
      args.visibility,
    );
  },
});
