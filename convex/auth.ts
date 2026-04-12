import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";

type QueryOrMutationCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

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
