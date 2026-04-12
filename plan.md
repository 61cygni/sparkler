# Sparkler — Implementation plan

Step-by-step build order for the Tigris + Convex + Vite (JS) + Spark 2.0 stack. Check off phases as you go.

**Prerequisites**

- [ ] Node.js LTS installed.
- [ ] Convex account and CLI (`npm create convex@latest` pattern or add Convex to repo).
- [ ] Tigris bucket created; S3 endpoint, region, access key, secret key available.
- [ ] Spark built locally: in [`../spark`](../spark/), run `npm install` and `npm run build` so `dist/` exists for the `file:` dependency.

---

## Phase 0 — Monorepo / project skeleton

- [x] Initialize **`sparkler`** as a Vite project: **Vanilla** or **React** + **JavaScript** (if using Convex React hooks, choose React template).
- [x] Add dependency: `"@sparkjsdev/spark": "file:../spark"` and **`three`** matching Spark’s expected range (see `../spark/package.json`).
- [x] Add `.gitignore` (node_modules, dist, `.env.local`, Convex generated dirs).
- [x] Document in README: clone layout with `spark` and `sparkler` siblings; build Spark before `npm install` in sparkler.

**Exit criteria**: `npm install` succeeds; a trivial Vite page runs on `localhost:5173`.

---

## Phase 1 — Convex foundation

- [x] Run Convex init in `sparkler` (or merge Convex into existing Vite app per current Convex + Vite docs).
- [x] Define **`scenes`** table schema (fields from [`architecture.md`](./architecture.md)); add indexes (`by_owner`, etc.).
- [x] Add **auth** (Clerk + Convex, with demo fallback for local dev) — minimum: identify `ownerSubject` on insert.
- [x] Implement **internal** helpers if needed (e.g. `requireAuth`, `requireSceneOwner`).

**Exit criteria**: Dashboard shows schema; test user can be identified in a stub mutation.

---

## Phase 2 — Tigris presign (Convex actions)

- [x] Store Tigris credentials in Convex **environment variables** (not in repo).
- [x] Add Convex **`package.json`** dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (or single presigner import per SDK version).
- [x] Create **`presignUpload`** action (`"use node"`): input `sceneId`, `contentType`, optional `byteSize`; validate owner; return presigned **PUT** URL + headers.
- [x] Optionally add **`verifyAndFinalize`** action: `HeadObject` on key, then patch scene to `ready` (`verifyObject` + client can call before finalize).
- [ ] Configure **Tigris bucket CORS** for local + production origins.

**Exit criteria**: From Convex dashboard or a test script, you can obtain a URL and `curl -T` a file successfully; object appears in bucket.

---

## Phase 3 — Upload UI + API wiring

- [x] **Mutation** `createScene`: create row `pending_upload` with deterministic `storageKey` (`splats/{id}.ext` from filename).
- [x] **Mutation** `finalizeScene`: after client PUT, set metadata and `ready` (or call verify action first).
- [x] **Upload page (JS)**:
  - [x] File input → read `name`, `type`, `size`.
  - [x] Call `createScene` → `presignUpload` → `fetch(PUT)` → `finalizeScene`.
  - [x] Surface errors (network, 403, finalize mismatch).
  - [ ] Optional: progress via `XMLHttpRequest`.

**Exit criteria**: End-to-end upload from browser; row in Convex `scenes` is `ready`; object in Tigris.

---

## Phase 4 — Spark 2.0 viewer (single scene)

- [x] Create **viewer route** `/s/:id` (or query param `?id=` if router not ready).
- [x] **Query** `getScene`: return title, visibility, and either **public URL** base + key or instruct client to call presign.
- [x] For **private** scenes: **action** `presignView` + client fetches URL once before creating `SplatMesh`.
- [x] **Three.js setup**: scene, camera, `WebGLRenderer` (**antialias: false** per Spark), resize handler, animation loop.
- [x] **SparkRenderer**: `new SparkRenderer({ renderer, onDirty: () => { ... } })`, `scene.add(sparkRenderer)`.
- [x] **SplatMesh**: `new SplatMesh({ url, lod: true })` (tune later); `scene.add(mesh)`; orientation helper if needed.
- [x] **Cleanup**: on navigate away, dispose renderer/meshes appropriately.

**Exit criteria**: Opening `/s/:id` loads uploaded splat from Tigris with Spark 2.0.

---

## Phase 5 — Gallery and polish

- [x] **List queries**: “my scenes” and/or public gallery (`visibility === "public"`).
- [x] **Home / gallery UI**: cards with title, link to viewer, upload CTA.
- [x] **Embed route** `/embed/:id`: minimal chrome; document iframe usage.
- [ ] **Environment**: production Convex deploy; production bucket; `VITE_CONVEX_URL` for client build.

**Exit criteria**: Upload → appears in list → open share link in fresh session (public path).

---

## Phase 6 — Hardening (optional before launch)

- [ ] Max upload size and allowed MIME/extension enforced in `presignUpload` + bucket policy if available.
- [ ] Stale `pending_upload` cleanup (scheduled mutation or manual script).
- [ ] Basic rate limiting pattern (e.g. cap `createScene` per user per hour in mutation).
- [ ] Error boundaries and loading states on viewer (slow Tigris / expired presign).

---

## Dependency reminder

| Step | Command / note |
|------|------------------|
| Build Spark | `cd ../spark && npm install && npm run build` |
| Convex dev | `npx convex dev` (from `sparkler`) |
| Vite dev | `npm run dev` |

---

## Open decisions (fill in as you implement)

- **Router**: React Router vs file-based (if using a meta-framework later — stay Vite SPA for simplicity).
- **Public URL shape**: CloudFront/custom domain on Tigris vs raw bucket URL (if Tigris exposes one).

Update this file when phases split or reorder; keep [`architecture.md`](./architecture.md) accurate for any structural change.
