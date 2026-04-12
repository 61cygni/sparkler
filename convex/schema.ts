import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  scenes: defineTable({
    ownerSubject: v.string(),
    title: v.string(),
    visibility: v.union(
      v.literal("public"),
      v.literal("unlisted"),
      v.literal("private"),
    ),
    storageKey: v.string(),
    filename: v.string(),
    contentType: v.optional(v.string()),
    byteSize: v.optional(v.number()),
    status: v.union(
      v.literal("pending_upload"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    defaultView: v.optional(
      v.object({
        position: v.array(v.number()),
        target: v.array(v.number()),
        quaternion: v.optional(v.array(v.number())),
      }),
    ),
    thumbnail: v.optional(
      v.object({
        storageKey: v.string(),
        contentType: v.string(),
        byteSize: v.number(),
        width: v.number(),
        height: v.number(),
        updatedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_owner_created", ["ownerSubject", "createdAt"])
    .index("by_visibility_created", ["visibility", "createdAt"]),
});
