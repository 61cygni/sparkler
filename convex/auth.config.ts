import type { AuthConfig } from "convex/server";

const clerkIssuer = process.env.CLERK_JWT_ISSUER?.trim();

export default {
  providers: clerkIssuer
    ? [
        {
          domain: clerkIssuer,
          applicationID: "convex",
        },
      ]
    : [],
} satisfies AuthConfig;
