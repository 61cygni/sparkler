import type { UserIdentity } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

type AccountRole = "user" | "admin";
type ApprovalStatus = "pending" | "approved" | "rejected";

type IdentityFields = {
  subject: string;
  tokenIdentifier: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

const roleValidator = v.union(v.literal("user"), v.literal("admin"));
const approvalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

const accountStatusValidator = v.object({
  subject: v.string(),
  email: v.union(v.string(), v.null()),
  name: v.union(v.string(), v.null()),
  role: roleValidator,
  approvalStatus: approvalStatusValidator,
  isAdmin: v.boolean(),
  isApproved: v.boolean(),
  isDemo: v.boolean(),
});

const adminUserValidator = v.object({
  _id: v.id("users"),
  subject: v.string(),
  email: v.union(v.string(), v.null()),
  name: v.union(v.string(), v.null()),
  role: roleValidator,
  approvalStatus: approvalStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function csvSet(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function emailDomain(email: string | null): string | null {
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) {
    return null;
  }
  return email.slice(at + 1);
}

function identityFields(identity: UserIdentity): IdentityFields {
  return {
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: normalizeEmail(identity.email),
    name: normalizeText(identity.name),
    imageUrl: normalizeText(identity.pictureUrl),
  };
}

function resolveBootstrap(
  identity: IdentityFields,
): { role: AccountRole; approvalStatus: ApprovalStatus } {
  const adminSubjects = csvSet(process.env.SPARKLER_ADMIN_SUBJECTS);
  const adminEmails = csvSet(process.env.SPARKLER_ADMIN_EMAILS);
  const autoApproveEmails = csvSet(process.env.SPARKLER_AUTO_APPROVE_EMAILS);
  const autoApproveDomains = csvSet(process.env.SPARKLER_AUTO_APPROVE_DOMAINS);

  const isAdmin =
    adminSubjects.has(identity.subject.toLowerCase()) ||
    (identity.email !== null && adminEmails.has(identity.email));

  if (isAdmin) {
    return {
      role: "admin",
      approvalStatus: "approved",
    };
  }

  const domain = emailDomain(identity.email);
  const isAutoApproved =
    (identity.email !== null && autoApproveEmails.has(identity.email)) ||
    (domain !== null && autoApproveDomains.has(domain));

  return {
    role: "user",
    approvalStatus: isAutoApproved ? "approved" : "pending",
  };
}

function statusFromUser(user: Doc<"users">) {
  return {
    subject: user.subject,
    email: user.email ?? null,
    name: user.name ?? null,
    role: user.role,
    approvalStatus: user.approvalStatus,
    isAdmin: user.role === "admin",
    isApproved: user.approvalStatus === "approved",
    isDemo: false,
  } as const;
}

function demoStatus(subject: string) {
  return {
    subject,
    email: null,
    name: "Local demo mode",
    role: "user" as const,
    approvalStatus: "approved" as const,
    isAdmin: false,
    isApproved: true,
    isDemo: true,
  };
}

async function requireIdentity(
  ctx: QueryCtx | MutationCtx,
): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }
  return identity;
}

async function getUserBySubject(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", subject))
    .unique();
}

async function getUserByTokenIdentifier(
  ctx: QueryCtx | MutationCtx,
  tokenIdentifier: string,
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
}

async function upsertUserForIdentity(
  ctx: MutationCtx,
  identity: IdentityFields,
): Promise<Doc<"users">> {
  const now = Date.now();
  const bootstrap = resolveBootstrap(identity);
  const existing =
    (await getUserBySubject(ctx, identity.subject)) ??
    (await getUserByTokenIdentifier(ctx, identity.tokenIdentifier));

  if (!existing) {
    const userId = await ctx.db.insert("users", {
      subject: identity.subject,
      tokenIdentifier: identity.tokenIdentifier,
      email: identity.email ?? undefined,
      name: identity.name ?? undefined,
      imageUrl: identity.imageUrl ?? undefined,
      role: bootstrap.role,
      approvalStatus: bootstrap.approvalStatus,
      createdAt: now,
      updatedAt: now,
      approvedAt: bootstrap.approvalStatus === "approved" ? now : undefined,
      approvedBySubject:
        bootstrap.approvalStatus === "approved" ? "env:auto" : undefined,
    });
    const created = await ctx.db.get(userId);
    if (!created) {
      throw new Error("Failed to create user account");
    }
    return created;
  }

  const patch: Partial<Doc<"users">> = {
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? undefined,
    name: identity.name ?? undefined,
    imageUrl: identity.imageUrl ?? undefined,
    updatedAt: now,
  };

  if (bootstrap.role === "admin" && existing.role !== "admin") {
    patch.role = "admin";
  }

  if (bootstrap.approvalStatus === "approved" && existing.approvalStatus !== "approved") {
    patch.approvalStatus = "approved";
    patch.approvedAt = now;
    patch.approvedBySubject = "env:auto";
    patch.rejectedAt = undefined;
    patch.rejectedBySubject = undefined;
  }

  await ctx.db.patch(existing._id, patch);
  const updated = await ctx.db.get(existing._id);
  if (!updated) {
    throw new Error("User account disappeared after update");
  }
  return updated;
}

async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const identity = await requireIdentity(ctx);
  const user = await getUserBySubject(ctx, identity.subject);
  if (!user) {
    throw new Error("Sparkler account not provisioned yet");
  }
  if (user.approvalStatus !== "approved" || user.role !== "admin") {
    throw new Error("Admin access required");
  }
  return user;
}

function adminView(user: Doc<"users">) {
  return {
    _id: user._id,
    subject: user.subject,
    email: user.email ?? null,
    name: user.name ?? null,
    role: user.role,
    approvalStatus: user.approvalStatus,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export const getMyAccountStatus = query({
  args: {},
  returns: v.union(accountStatusValidator, v.null()),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      const demoSubject = process.env.SPARKLER_DEMO_OWNER_SUBJECT?.trim();
      return demoSubject ? demoStatus(demoSubject) : null;
    }

    const existing = await getUserBySubject(ctx, identity.subject);
    if (existing) {
      return statusFromUser(existing);
    }

    const derived = resolveBootstrap(identityFields(identity));
    return {
      subject: identity.subject,
      email: normalizeEmail(identity.email),
      name: normalizeText(identity.name),
      role: derived.role,
      approvalStatus: derived.approvalStatus,
      isAdmin: derived.role === "admin",
      isApproved: derived.approvalStatus === "approved",
      isDemo: false,
    };
  },
});

export const storeCurrentUser = mutation({
  args: {},
  returns: accountStatusValidator,
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const user = await upsertUserForIdentity(ctx, identityFields(identity));
    return statusFromUser(user);
  },
});

export const listUsersByApprovalStatus = query({
  args: {
    approvalStatus: v.optional(approvalStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(adminUserValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const limit = Math.max(1, Math.min(args.limit ?? 100, 200));
    const status = args.approvalStatus;

    const rows = status
      ? await ctx.db
          .query("users")
          .withIndex("by_approval_created", (q) => q.eq("approvalStatus", status))
          .order("desc")
          .take(limit)
      : await ctx.db.query("users").order("desc").take(limit);

    return rows.map(adminView);
  },
});

export const setUserApprovalStatus = mutation({
  args: {
    userId: v.id("users"),
    approvalStatus: approvalStatusValidator,
  },
  returns: adminUserValidator,
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const target = await ctx.db.get(args.userId);
    if (!target) {
      throw new Error("User not found");
    }

    const now = Date.now();
    const patch: Partial<Doc<"users">> = {
      approvalStatus: args.approvalStatus,
      updatedAt: now,
    };

    if (args.approvalStatus === "approved") {
      patch.approvedAt = now;
      patch.approvedBySubject = admin.subject;
      patch.rejectedAt = undefined;
      patch.rejectedBySubject = undefined;
    } else if (args.approvalStatus === "rejected") {
      patch.rejectedAt = now;
      patch.rejectedBySubject = admin.subject;
    }

    await ctx.db.patch(args.userId, patch);
    const updated = await ctx.db.get(args.userId);
    if (!updated) {
      throw new Error("User not found after update");
    }
    return adminView(updated);
  },
});

export const getBySubject = internalQuery({
  args: { subject: v.string() },
  handler: async (ctx, args) => {
    return await getUserBySubject(ctx, args.subject);
  },
});

export const ensureCurrentUser = internalMutation({
  args: {
    subject: v.string(),
    tokenIdentifier: v.string(),
    email: v.union(v.string(), v.null()),
    name: v.union(v.string(), v.null()),
    imageUrl: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await upsertUserForIdentity(ctx, args);
    return statusFromUser(user);
  },
});
