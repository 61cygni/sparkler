import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { components } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
type HttpActionCtx = Parameters<typeof httpAction>[0] extends (
  ctx: infer C,
  request: Request,
) => Promise<Response>
  ? C
  : never;
type CliUserStatus = {
  subject: string;
  email: string | null;
  name: string | null;
  role: "user" | "admin";
  approvalStatus: "pending" | "approved" | "rejected";
  isAdmin: boolean;
  isApproved: boolean;
  isDemo: boolean;
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

function cliAuth(request: Request): boolean {
  const secret = process.env.SPARKLER_CLI_SECRET;
  if (!secret) {
    return false;
  }
  const auth = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) {
    return false;
  }
  const token = auth.slice(prefix.length);
  return timingSafeEqual(token, secret);
}

function parseVisibility(value: unknown): "public" | "unlisted" | "private" {
  if (value === "public" || value === "private" || value === "unlisted") {
    return value;
  }
  return "unlisted";
}

function parseAudioKind(value: unknown): "background" | "positional" | null {
  if (value === "background" || value === "positional") {
    return value;
  }
  return null;
}

function sceneAudioBody(scene: {
  audio?: {
    background?: unknown;
    positional?: unknown[];
  };
}) {
  return {
    background: scene.audio?.background ?? null,
    positional: scene.audio?.positional ?? [],
  };
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: jsonHeaders,
  });
}

async function requireCliUser(
  ctx: HttpActionCtx,
  allowPending = false,
): Promise<
  | {
      ok: false;
      response: Response;
    }
  | {
      ok: true;
      identity: NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;
      status: CliUserStatus;
    }
> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) {
    return {
      ok: false,
      response: jsonError("Not authenticated. Run sparkler login first.", 401),
    };
  }

  const status = await ctx.runMutation(internal.users.ensureCurrentUser, {
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? null,
    name: identity.name ?? null,
    imageUrl: identity.pictureUrl ?? null,
  });

  if (!allowPending && !status.isApproved) {
    const message =
      status.approvalStatus === "pending"
        ? "Your Sparkler account is pending approval."
        : "Your Sparkler account was rejected.";
    return {
      ok: false,
      response: jsonError(message, 403),
    };
  }

  return {
    ok: true,
    identity,
    status,
  };
}

const http = httpRouter();
const selfHosting = (components as { selfHosting: Parameters<typeof registerStaticRoutes>[1] })
  .selfHosting;

http.route({
  path: "/api/cli/me",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const auth = await requireCliUser(ctx, true);
    if (!auth.ok) {
      return auth.response;
    }
    return new Response(JSON.stringify(auth.status), {
      status: 200,
      headers: jsonHeaders,
    });
  }),
});

http.route({
  path: "/api/cli/upload-session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const filename = body.filename;
    if (typeof filename !== "string" || !filename.trim()) {
      return jsonError("filename is required", 400);
    }

    const title = typeof body.title === "string" ? body.title : undefined;
    const visibility = parseVisibility(body.visibility);
    const contentType =
      typeof body.contentType === "string" ? body.contentType : undefined;
    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;

    try {
      const created = await ctx.runMutation(internal.scenes.createForOwner, {
        ownerSubject: auth.identity.subject,
        filename: filename.trim(),
        title,
        visibility,
        contentType,
        byteSize,
      });
      const presign = await ctx.runAction(internal.tigrisCli.presignUploadForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: created.sceneId as never,
        contentType,
        byteSize,
      });
      return new Response(
        JSON.stringify({
          sceneId: created.sceneId,
          storageKey: created.storageKey,
          uploadUrl: presign.url,
          headers: presign.headers,
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/finalize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return jsonError("sceneId is required", 400);
    }

    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    const contentType =
      typeof body.contentType === "string" ? body.contentType : undefined;

    try {
      await ctx.runMutation(internal.scenes.finalizeForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId.trim() as never,
        byteSize,
        contentType,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/mark-failed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return jsonError("sceneId is required", 400);
    }

    try {
      await ctx.runMutation(internal.scenes.markFailedForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId.trim() as never,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/scenes",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    const url = new URL(request.url);
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;

    try {
      const rows = await ctx.runQuery(internal.scenes.listForOwner, {
        ownerSubject: auth.identity.subject,
        limit,
      });
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return jsonError("sceneId is required", 400);
    }

    try {
      await ctx.runAction(internal.sceneDelete.deleteForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId.trim() as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId: sceneId.trim() }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/set-view",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const sceneId = body.sceneId;
    const defaultView = body.defaultView;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return jsonError("sceneId is required", 400);
    }
    if (!defaultView || typeof defaultView !== "object") {
      return jsonError("defaultView is required", 400);
    }

    try {
      await ctx.runMutation(internal.scenes.updateDefaultViewForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId.trim() as never,
        defaultView: defaultView as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId: sceneId.trim() }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/set-visibility",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return jsonError("sceneId is required", 400);
    }
    const visibility = parseVisibility(body.visibility);

    try {
      await ctx.runMutation(internal.scenes.updateVisibilityForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId.trim() as never,
        visibility,
      });
      return new Response(
        JSON.stringify({ ok: true, sceneId: sceneId.trim(), visibility }),
        {
          status: 200,
          headers: jsonHeaders,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/adopt-demo-scenes",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx, true);
    if (!auth.ok) {
      return auth.response;
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const batchSize =
      typeof body.batchSize === "number" && Number.isFinite(body.batchSize)
        ? body.batchSize
        : undefined;

    try {
      const result = await ctx.runMutation(internal.scenes.adoptDemoScenesForSubject, {
        adoptedSubject: auth.identity.subject,
        batchSize,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/cli/upload-session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const filename = body.filename;
    if (typeof filename !== "string" || !filename.trim()) {
      return new Response(JSON.stringify({ error: "filename is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const title = typeof body.title === "string" ? body.title : undefined;
    const visibility = parseVisibility(body.visibility);
    const contentType =
      typeof body.contentType === "string" ? body.contentType : undefined;
    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;

    let created: { sceneId: string; storageKey: string };
    try {
      created = await ctx.runMutation(internal.scenes.createForCli, {
        filename: filename.trim(),
        title,
        visibility,
        contentType,
        byteSize,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    let presign: { url: string; headers: { "Content-Type": string } };
    try {
      presign = await ctx.runAction(internal.tigrisCli.presignUploadForCli, {
        sceneId: created.sceneId as never,
        contentType,
        byteSize,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await ctx.runMutation(internal.scenes.markFailedForCli, {
          sceneId: created.sceneId as never,
        });
      } catch {
        /* best effort */
      }
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    return new Response(
      JSON.stringify({
        sceneId: created.sceneId,
        storageKey: created.storageKey,
        uploadUrl: presign.url,
        headers: presign.headers,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }),
});

http.route({
  path: "/cli/finalize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    const contentType =
      typeof body.contentType === "string" ? body.contentType : undefined;

    try {
      await ctx.runMutation(internal.scenes.finalizeForCli, {
        sceneId: sceneId.trim() as never,
        byteSize,
        contentType,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  }),
});

http.route({
  path: "/cli/mark-failed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    try {
      await ctx.runMutation(internal.scenes.markFailedForCli, {
        sceneId: sceneId.trim() as never,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: jsonHeaders,
    });
  }),
});

http.route({
  path: "/cli/scenes",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const url = new URL(request.url);
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;

    try {
      const rows = await ctx.runQuery(internal.scenes.listForCli, { limit });
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    try {
      await ctx.runAction(internal.sceneDelete.deleteForCli, {
        sceneId: sceneId.trim() as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId: sceneId.trim() }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/set-view",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const sceneId = body.sceneId;
    const defaultView = body.defaultView;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    if (!defaultView || typeof defaultView !== "object") {
      return new Response(JSON.stringify({ error: "defaultView is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    try {
      await ctx.runMutation(internal.scenes.updateDefaultViewForCli, {
        sceneId: sceneId.trim() as never,
        defaultView: defaultView as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId: sceneId.trim() }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/set-visibility",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const sceneId = body.sceneId;
    if (typeof sceneId !== "string" || !sceneId.trim()) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const visibility = parseVisibility(body.visibility);

    try {
      await ctx.runMutation(internal.scenes.updateVisibilityForCli, {
        sceneId: sceneId.trim() as never,
        visibility,
      });
      return new Response(
        JSON.stringify({ ok: true, sceneId: sceneId.trim(), visibility }),
        {
          status: 200,
          headers: jsonHeaders,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/api/cli/audio",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }
    const url = new URL(request.url);
    const sceneId = url.searchParams.get("sceneId");
    if (!sceneId?.trim()) {
      return jsonError("sceneId is required", 400);
    }
    try {
      const scene = await ctx.runQuery(internal.sceneInternals.get, {
        sceneId: sceneId.trim() as never,
      });
      if (!scene || scene.ownerSubject !== auth.identity.subject) {
        return jsonError("Not found or forbidden", 404);
      }
      return new Response(
        JSON.stringify({
          sceneId: sceneId.trim(),
          ...sceneAudioBody(scene),
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/audio/background",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!sceneId || !filename) {
      return jsonError("sceneId and filename are required", 400);
    }
    const contentType = typeof body.contentType === "string" ? body.contentType : undefined;
    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    const volume =
      typeof body.volume === "number" && Number.isFinite(body.volume) ? body.volume : undefined;
    const loop = typeof body.loop === "boolean" ? body.loop : undefined;
    try {
      const presign = await ctx.runAction(internal.tigrisCli.presignAudioUploadForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId as never,
        filename,
        kind: "background",
        contentType,
        byteSize,
      });
      const audio = {
        storageKey: presign.storageKey,
        filename,
        contentType: contentType ?? presign.headers["Content-Type"],
        byteSize: byteSize ?? 0,
        ...(volume !== undefined ? { volume } : {}),
        ...(loop !== undefined ? { loop } : {}),
      };
      await ctx.runMutation(internal.scenes.setBackgroundAudioForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId as never,
        audio: audio as never,
      });
      return new Response(
        JSON.stringify({
          uploadUrl: presign.url,
          headers: presign.headers,
          storageKey: presign.storageKey,
          audio,
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/audio/positional",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    const audioId = typeof body.audioId === "string" ? body.audioId.trim() : "";
    const position = Array.isArray(body.position) ? body.position.map(Number) : null;
    if (!sceneId || !filename || !audioId || !position || position.length < 3) {
      return jsonError("sceneId, filename, audioId, and 3-number position are required", 400);
    }
    const contentType = typeof body.contentType === "string" ? body.contentType : undefined;
    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    const volume =
      typeof body.volume === "number" && Number.isFinite(body.volume) ? body.volume : undefined;
    const loop = typeof body.loop === "boolean" ? body.loop : undefined;
    const refDistance =
      typeof body.refDistance === "number" && Number.isFinite(body.refDistance)
        ? body.refDistance
        : undefined;
    const maxDistance =
      typeof body.maxDistance === "number" && Number.isFinite(body.maxDistance)
        ? body.maxDistance
        : undefined;
    const rolloffFactor =
      typeof body.rolloffFactor === "number" && Number.isFinite(body.rolloffFactor)
        ? body.rolloffFactor
        : undefined;
    try {
      const presign = await ctx.runAction(internal.tigrisCli.presignAudioUploadForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId as never,
        filename,
        kind: "positional",
        audioId,
        contentType,
        byteSize,
      });
      const audio = {
        id: audioId,
        storageKey: presign.storageKey,
        filename,
        contentType: contentType ?? presign.headers["Content-Type"],
        byteSize: byteSize ?? 0,
        position: position.slice(0, 3),
        ...(volume !== undefined ? { volume } : {}),
        ...(loop !== undefined ? { loop } : {}),
        ...(refDistance !== undefined ? { refDistance } : {}),
        ...(maxDistance !== undefined ? { maxDistance } : {}),
        ...(rolloffFactor !== undefined ? { rolloffFactor } : {}),
      };
      await ctx.runMutation(internal.scenes.addPositionalAudioForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId as never,
        audio: audio as never,
      });
      return new Response(
        JSON.stringify({
          uploadUrl: presign.url,
          headers: presign.headers,
          storageKey: presign.storageKey,
          audio,
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/audio/background/set",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    if (!sceneId) {
      return jsonError("sceneId is required", 400);
    }
    try {
      const scene = await ctx.runQuery(internal.sceneInternals.get, {
        sceneId: sceneId as never,
      });
      if (!scene || scene.ownerSubject !== auth.identity.subject || !scene.audio?.background) {
        return jsonError("Background audio not found", 404);
      }
      const audio = {
        ...scene.audio.background,
        ...(typeof body.volume === "number" && Number.isFinite(body.volume)
          ? { volume: body.volume }
          : {}),
        ...(typeof body.loop === "boolean" ? { loop: body.loop } : {}),
      };
      await ctx.runMutation(internal.scenes.setBackgroundAudioForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId as never,
        audio: audio as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/audio/positional/set",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const audioId = typeof body.audioId === "string" ? body.audioId.trim() : "";
    if (!sceneId || !audioId) {
      return jsonError("sceneId and audioId are required", 400);
    }
    const patch: Record<string, unknown> = {};
    if (Array.isArray(body.position)) patch.position = body.position.map(Number).slice(0, 3);
    if (typeof body.volume === "number" && Number.isFinite(body.volume)) patch.volume = body.volume;
    if (typeof body.loop === "boolean") patch.loop = body.loop;
    if (typeof body.refDistance === "number" && Number.isFinite(body.refDistance)) {
      patch.refDistance = body.refDistance;
    }
    if (typeof body.maxDistance === "number" && Number.isFinite(body.maxDistance)) {
      patch.maxDistance = body.maxDistance;
    }
    if (typeof body.rolloffFactor === "number" && Number.isFinite(body.rolloffFactor)) {
      patch.rolloffFactor = body.rolloffFactor;
    }
    try {
      await ctx.runMutation(internal.scenes.updatePositionalAudioForOwner, {
        ownerSubject: auth.identity.subject,
        sceneId: sceneId as never,
        audioId,
        patch: patch as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId, audioId }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/api/cli/audio/remove",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await requireCliUser(ctx);
    if (!auth.ok) {
      return auth.response;
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const kind = parseAudioKind(body.kind);
    if (!sceneId || !kind) {
      return jsonError("sceneId and kind are required", 400);
    }
    try {
      if (kind === "background") {
        await ctx.runMutation(internal.scenes.removeBackgroundAudioForOwner, {
          ownerSubject: auth.identity.subject,
          sceneId: sceneId as never,
        });
      } else {
        const audioId = typeof body.audioId === "string" ? body.audioId.trim() : "";
        if (!audioId) {
          return jsonError("audioId is required for positional audio", 400);
        }
        await ctx.runMutation(internal.scenes.removePositionalAudioForOwner, {
          ownerSubject: auth.identity.subject,
          sceneId: sceneId as never,
          audioId,
        });
      }
      return new Response(JSON.stringify({ ok: true, sceneId, kind }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(msg, 400);
    }
  }),
});

http.route({
  path: "/cli/audio",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    const url = new URL(request.url);
    const sceneId = url.searchParams.get("sceneId");
    if (!sceneId?.trim()) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    try {
      const scene = await ctx.runQuery(internal.sceneInternals.get, {
        sceneId: sceneId.trim() as never,
      });
      const owner = process.env.SPARKLER_CLI_OWNER_SUBJECT?.trim();
      if (!scene || scene.ownerSubject !== owner) {
        return new Response(JSON.stringify({ error: "Not found or forbidden" }), {
          status: 404,
          headers: jsonHeaders,
        });
      }
      return new Response(
        JSON.stringify({
          sceneId: sceneId.trim(),
          ...sceneAudioBody(scene),
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/audio/background",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!sceneId || !filename) {
      return new Response(JSON.stringify({ error: "sceneId and filename are required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const contentType = typeof body.contentType === "string" ? body.contentType : undefined;
    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    const volume =
      typeof body.volume === "number" && Number.isFinite(body.volume) ? body.volume : undefined;
    const loop = typeof body.loop === "boolean" ? body.loop : undefined;
    try {
      const presign = await ctx.runAction(internal.tigrisCli.presignAudioUploadForCli, {
        sceneId: sceneId as never,
        filename,
        kind: "background",
        contentType,
        byteSize,
      });
      const audio = {
        storageKey: presign.storageKey,
        filename,
        contentType: contentType ?? presign.headers["Content-Type"],
        byteSize: byteSize ?? 0,
        ...(volume !== undefined ? { volume } : {}),
        ...(loop !== undefined ? { loop } : {}),
      };
      await ctx.runMutation(internal.scenes.setBackgroundAudioForCli, {
        sceneId: sceneId as never,
        audio: audio as never,
      });
      return new Response(
        JSON.stringify({
          uploadUrl: presign.url,
          headers: presign.headers,
          storageKey: presign.storageKey,
          audio,
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/audio/positional",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    const audioId = typeof body.audioId === "string" ? body.audioId.trim() : "";
    const position = Array.isArray(body.position) ? body.position.map(Number) : null;
    if (!sceneId || !filename || !audioId || !position || position.length < 3) {
      return new Response(
        JSON.stringify({
          error: "sceneId, filename, audioId, and 3-number position are required",
        }),
        { status: 400, headers: jsonHeaders },
      );
    }
    const contentType = typeof body.contentType === "string" ? body.contentType : undefined;
    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    const volume =
      typeof body.volume === "number" && Number.isFinite(body.volume) ? body.volume : undefined;
    const loop = typeof body.loop === "boolean" ? body.loop : undefined;
    const refDistance =
      typeof body.refDistance === "number" && Number.isFinite(body.refDistance)
        ? body.refDistance
        : undefined;
    const maxDistance =
      typeof body.maxDistance === "number" && Number.isFinite(body.maxDistance)
        ? body.maxDistance
        : undefined;
    const rolloffFactor =
      typeof body.rolloffFactor === "number" && Number.isFinite(body.rolloffFactor)
        ? body.rolloffFactor
        : undefined;
    try {
      const presign = await ctx.runAction(internal.tigrisCli.presignAudioUploadForCli, {
        sceneId: sceneId as never,
        filename,
        kind: "positional",
        audioId,
        contentType,
        byteSize,
      });
      const audio = {
        id: audioId,
        storageKey: presign.storageKey,
        filename,
        contentType: contentType ?? presign.headers["Content-Type"],
        byteSize: byteSize ?? 0,
        position: position.slice(0, 3),
        ...(volume !== undefined ? { volume } : {}),
        ...(loop !== undefined ? { loop } : {}),
        ...(refDistance !== undefined ? { refDistance } : {}),
        ...(maxDistance !== undefined ? { maxDistance } : {}),
        ...(rolloffFactor !== undefined ? { rolloffFactor } : {}),
      };
      await ctx.runMutation(internal.scenes.addPositionalAudioForCli, {
        sceneId: sceneId as never,
        audio: audio as never,
      });
      return new Response(
        JSON.stringify({
          uploadUrl: presign.url,
          headers: presign.headers,
          storageKey: presign.storageKey,
          audio,
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/audio/background/set",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    if (!sceneId) {
      return new Response(JSON.stringify({ error: "sceneId is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    try {
      const scene = await ctx.runQuery(internal.sceneInternals.get, {
        sceneId: sceneId as never,
      });
      const owner = process.env.SPARKLER_CLI_OWNER_SUBJECT?.trim();
      if (!scene || scene.ownerSubject !== owner || !scene.audio?.background) {
        return new Response(JSON.stringify({ error: "Background audio not found" }), {
          status: 404,
          headers: jsonHeaders,
        });
      }
      const audio = {
        ...scene.audio.background,
        ...(typeof body.volume === "number" && Number.isFinite(body.volume)
          ? { volume: body.volume }
          : {}),
        ...(typeof body.loop === "boolean" ? { loop: body.loop } : {}),
      };
      await ctx.runMutation(internal.scenes.setBackgroundAudioForCli, {
        sceneId: sceneId as never,
        audio: audio as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/audio/positional/set",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const audioId = typeof body.audioId === "string" ? body.audioId.trim() : "";
    if (!sceneId || !audioId) {
      return new Response(JSON.stringify({ error: "sceneId and audioId are required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const patch: Record<string, unknown> = {};
    if (Array.isArray(body.position)) patch.position = body.position.map(Number).slice(0, 3);
    if (typeof body.volume === "number" && Number.isFinite(body.volume)) patch.volume = body.volume;
    if (typeof body.loop === "boolean") patch.loop = body.loop;
    if (typeof body.refDistance === "number" && Number.isFinite(body.refDistance)) {
      patch.refDistance = body.refDistance;
    }
    if (typeof body.maxDistance === "number" && Number.isFinite(body.maxDistance)) {
      patch.maxDistance = body.maxDistance;
    }
    if (typeof body.rolloffFactor === "number" && Number.isFinite(body.rolloffFactor)) {
      patch.rolloffFactor = body.rolloffFactor;
    }
    try {
      await ctx.runMutation(internal.scenes.updatePositionalAudioForCli, {
        sceneId: sceneId as never,
        audioId,
        patch: patch as never,
      });
      return new Response(JSON.stringify({ ok: true, sceneId, audioId }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

http.route({
  path: "/cli/audio/remove",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!process.env.SPARKLER_CLI_SECRET) {
      return new Response(
        JSON.stringify({ error: "CLI is disabled (SPARKLER_CLI_SECRET not set)" }),
        { status: 503, headers: jsonHeaders },
      );
    }
    if (!cliAuth(request)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const kind = parseAudioKind(body.kind);
    if (!sceneId || !kind) {
      return new Response(JSON.stringify({ error: "sceneId and kind are required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    try {
      if (kind === "background") {
        await ctx.runMutation(internal.scenes.removeBackgroundAudioForCli, {
          sceneId: sceneId as never,
        });
      } else {
        const audioId = typeof body.audioId === "string" ? body.audioId.trim() : "";
        if (!audioId) {
          return new Response(
            JSON.stringify({ error: "audioId is required for positional audio" }),
            { status: 400, headers: jsonHeaders },
          );
        }
        await ctx.runMutation(internal.scenes.removePositionalAudioForCli, {
          sceneId: sceneId as never,
          audioId,
        });
      }
      return new Response(JSON.stringify({ ok: true, sceneId, kind }), {
        status: 200,
        headers: jsonHeaders,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
  }),
});

registerStaticRoutes(http, selfHosting);

export default http;
