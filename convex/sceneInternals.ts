import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const get = internalQuery({
  args: { sceneId: v.id("scenes") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sceneId);
  },
});
