import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";

type QueryOrMutationCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

function approvalErrorMessage(status: Doc<"users">["approvalStatus"]): string {
  if (status === "pending") {
    return "Your Sparkler account is pending approval. Ask an admin to approve it before hosting or editing scenes.";
  }
  if (status === "rejected") {
    return "Your Sparkler account was rejected. Contact a Sparkler admin if you need access.";
  }
  return "Your Sparkler account is not approved.";
}

async function requireApprovedAccount(
  ctx: QueryOrMutationCtx,
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    const demo = process.env.SPARKLER_DEMO_OWNER_SUBJECT?.trim();
    if (demo) {
      return null;
    }
    throw new Error(
      "Not authenticated. Add Clerk (see README) or set SPARKLER_DEMO_OWNER_SUBJECT in Convex env for local dev.",
    );
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
    .unique();
  if (!user) {
    throw new Error(
      "Your Sparkler account has not been provisioned yet. Sign in through the web app once and ask an admin to approve you.",
    );
  }
  if (user.approvalStatus !== "approved") {
    throw new Error(approvalErrorMessage(user.approvalStatus));
  }
  return user;
}

/**
 * Resolved viewer id: Clerk subject, or SPARKLER_DEMO_OWNER_SUBJECT when no auth provider (dev only).
 */
export async function getViewerSubject(
  ctx: QueryOrMutationCtx,
): Promise<string | null> {
  const id = await ctx.auth.getUserIdentity();
  if (id?.subject) {
    return id.subject;
  }
  const demo = process.env.SPARKLER_DEMO_OWNER_SUBJECT;
  if (demo) {
    return demo;
  }
  return null;
}

export async function requireViewerSubject(
  ctx: GenericMutationCtx<DataModel>,
): Promise<string> {
  const s = await getViewerSubject(ctx);
  if (!s) {
    throw new Error(
      "Not authenticated. Add Clerk (see README) or set SPARKLER_DEMO_OWNER_SUBJECT in Convex env for local dev.",
    );
  }
  return s;
}

export async function requireApprovedViewerSubject(
  ctx: GenericMutationCtx<DataModel>,
): Promise<string> {
  const approved = await requireApprovedAccount(ctx);
  return approved?.subject ?? process.env.SPARKLER_DEMO_OWNER_SUBJECT!.trim();
}

export async function requireViewerSubjectAction(
  ctx: GenericActionCtx<DataModel>,
): Promise<string> {
  const subject = await getViewerSubjectAction(ctx);
  if (subject) {
    return subject;
  }
  throw new Error(
    "Not authenticated. Add Clerk or set SPARKLER_DEMO_OWNER_SUBJECT in Convex env (dev only).",
  );
}

export async function requireApprovedViewerSubjectAction(
  ctx: GenericActionCtx<DataModel>,
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    const demo = process.env.SPARKLER_DEMO_OWNER_SUBJECT?.trim();
    if (demo) {
      return demo;
    }
    throw new Error(
      "Not authenticated. Add Clerk or set SPARKLER_DEMO_OWNER_SUBJECT in Convex env (dev only).",
    );
  }

  const status = await ctx.runMutation(internal.users.ensureCurrentUser, {
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? null,
    name: identity.name ?? null,
    imageUrl: identity.pictureUrl ?? null,
  });
  if (!status.isApproved) {
    throw new Error(approvalErrorMessage(status.approvalStatus));
  }
  return identity.subject;
}

export async function requireAuthenticatedSubject(
  ctx: QueryOrMutationCtx,
): Promise<string> {
  const id = await ctx.auth.getUserIdentity();
  if (id?.subject) {
    return id.subject;
  }
  throw new Error("Not authenticated");
}

export async function requireAdminUser(
  ctx: QueryOrMutationCtx,
): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) {
    throw new Error("Not authenticated");
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
    .unique();
  if (!user || user.approvalStatus !== "approved" || user.role !== "admin") {
    throw new Error("Admin access required");
  }
  return user;
}

export async function getViewerSubjectAction(
  ctx: GenericActionCtx<DataModel>,
): Promise<string | null> {
  const id = await ctx.auth.getUserIdentity();
  if (id?.subject) {
    return id.subject;
  }
  const demo = process.env.SPARKLER_DEMO_OWNER_SUBJECT;
  if (demo) {
    return demo;
  }
  return null;
}
