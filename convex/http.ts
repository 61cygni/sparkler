import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { components } from "./_generated/api";
import { httpAction } from "./_generated/server";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

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

const http = httpRouter();
const selfHosting = (components as { selfHosting: Parameters<typeof registerStaticRoutes>[1] })
  .selfHosting;

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

registerStaticRoutes(http, selfHosting);

export default http;
