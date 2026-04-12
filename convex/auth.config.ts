import type { AuthConfig } from "convex/server";

// Local demo mode: keep Convex auth disabled unless/until Clerk is wired back in.
export default {
  providers: [],
} satisfies AuthConfig;
