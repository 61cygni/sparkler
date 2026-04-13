import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    subject: v.string(),
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("admin")),
    approvalStatus: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    approvedAt: v.optional(v.number()),
    approvedBySubject: v.optional(v.string()),
    rejectedAt: v.optional(v.number()),
    rejectedBySubject: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subject", ["subject"])
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_approval_created", ["approvalStatus", "createdAt"]),
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
    audio: v.optional(
      v.object({
        background: v.optional(
          v.object({
            storageKey: v.string(),
            filename: v.string(),
            contentType: v.string(),
            byteSize: v.number(),
            volume: v.optional(v.number()),
            loop: v.optional(v.boolean()),
          }),
        ),
        positional: v.optional(
          v.array(
            v.object({
              id: v.string(),
              storageKey: v.string(),
              filename: v.string(),
              contentType: v.string(),
              byteSize: v.number(),
              position: v.array(v.number()),
              volume: v.optional(v.number()),
              loop: v.optional(v.boolean()),
              refDistance: v.optional(v.number()),
              maxDistance: v.optional(v.number()),
              rolloffFactor: v.optional(v.number()),
            }),
          ),
        ),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_owner_created", ["ownerSubject", "createdAt"])
    .index("by_visibility_created", ["visibility", "createdAt"]),
});
