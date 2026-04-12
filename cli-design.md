# Sparkler CLI — design

This document describes a **CLI-first** workflow for turning a local splat file (`.spz`, `.ply`, …) into a **single shareable URL** on the open web: a hosted viewer page with good defaults (LoD `.rad`, paged streaming, movement controls, embed help, saved default view).

**Status:** The CLI now implements `login`, `convert`, `host`, `dashboard`, `list`, `del`, `set-visibility`, `set-view`, `adopt-demo-scenes`, and `embed-snippet`. The default `host` conversion path is implemented, as are three auth modes: Clerk login, demo/no-auth dev mode, and shared-secret admin automation. The public installed CLI now uses authenticated `/api/cli/*` routes on `*.convex.site` instead of importing this repo’s generated Convex API directly. The full viewer now uses Spark paged loading for `.rad`, has `WASD` movement, `Shift` run, `Q/E` roll, `R/F` up/down, a mobile joystick, and a capture-to-thumbnail flow that feeds the dashboard cards. The main remaining target UX gaps are a more polished combined info/embed panel and any future VR-specific work.

---

## Design principle: one obvious path

**Goal:** A creator who just installed the CLI should be able to run two commands and get a link they can paste anywhere.

```bash
sparkler login
sparkler host myscan.spz
```

That’s the **default story**. Everything else (explicit convert-only, raw upload, scripting flags) is **advanced**.

For first-time users, the hosted app can also serve a bootstrap installer:

```bash
curl -fsSL https://<deployment>.convex.site/setup.sh -o setup.sh
bash setup.sh
```

That installer checks Node/npm, downloads the Sparkler source tarball from GitHub, runs `npm install` for `packages/cli`, keeps the install/config state in the current directory by default, and then points the user at `./bin/sparkler login`.

---

## Golden path

### 1. `sparkler login`

**Purpose:** Configure **who** and **where** in one step—no hand-editing of Convex URLs, site URLs, or long-lived secrets in shell profiles unless the user wants to.

**Behavior (implemented):**

1. Opens the Sparkler app’s `/cli-login` page in the browser.
2. Uses Clerk to mint a Convex JWT and returns it to the CLI over a loopback callback.
3. Writes **`$XDG_CONFIG_HOME/sparkler/credentials.json`** with:
   - **`convexUrl`** — `https://<deployment>.convex.cloud`
   - **`deploymentUrl`** — origin where the viewer app is served
   - **`accessToken`** — Clerk-issued Convex JWT
4. Immediately verifies the account over `/api/cli/me`, so the user can see whether Sparkler access is already **approved** or still **pending** admin review.

**Installer note:** the setup script now defaults `XDG_CONFIG_HOME` to `./.config`, so deleting the install directory removes the saved Sparkler config and login state too.

**Fallbacks:**

- **Demo mode:** `--demo` or `SPARKLER_DEMO=1` with Convex `SPARKLER_DEMO_OWNER_SUBJECT`
- **Admin automation mode:** `SPARKLER_CLI_TOKEN`, `SPARKLER_CONVEX_SITE_URL`, `SPARKLER_DEPLOYMENT_URL`
- **Config/env loading:** the CLI auto-loads `.env` and `.env.local` from the current working directory, and honors `SPARKLER_ENV_FILE`

**Design rule:** After a successful `login`, **`sparkler host`** should work with **zero extra env vars**.

**Practical note:** The CLI now prefers saved Clerk credentials over an ambient `SPARKLER_DEMO=1` environment flag unless `--demo` is passed explicitly. This makes it safer to move from no-auth local testing to real auth without constantly editing `.env`.

**Approval rule:** successful Clerk sign-in is necessary but not sufficient. Protected commands are blocked until the user’s Sparkler account has `approvalStatus = approved`.

---

### 2. `sparkler host <filename>`

**Purpose:** From a path on disk → **uploaded asset + one primary URL** for a full-featured viewer page.

#### Default behavior (non-`.rad` inputs, e.g. `.spz`, `.ply`)

When the file is **not** already `.rad`:

1. **Convert in-process for upload** (user does not run `convert` separately):
   - Invoke Spark’s **`build-lod`** with **`--quality`** (Spark’s higher-quality LoD path) so the hosted asset is a **`.rad`** suitable for large scenes and consistent viewer performance.
   - Use a **temp directory** (e.g. system temp + unique subfolder); clean it up after upload.
2. **Upload** the resulting `.rad` to Tigris via authenticated `/api/cli/*` routes (or demo/admin-automation fallback) and a presigned PUT URL.
3. **Register** the scene in Convex (title from basename unless `--title`, visibility default **unlisted** unless changed).
4. **Print one line** (human default): the **viewer page URL**  
   `https://<deployment>/s/<sceneId>`  
   Optionally also print embed URL on a second line or only with `--verbose` / `--json`.

#### Default behavior (input already `.rad`)

Skip conversion; upload as today.

#### Advanced overrides (explicit, documented in `--help`)

| Flag | Purpose |
|------|---------|
| `--no-convert` | Upload raw `.spz` / `.ply` without building `.rad` (smaller local work, different viewer tradeoffs). |
| `--quick` | Use Spark’s quicker LoD preset instead of `--quality` (faster, lower-quality tree). |
| `--title`, `--visibility` | Same as today. |
| `--demo` | Use no-auth dev mode backed by Convex `SPARKLER_DEMO_OWNER_SUBJECT`. |
| `--json` | Machine-readable output for CI (scene id, viewer URL, embed URL, bytes, etc.). |
| `--verbose` | Print labeled viewer + embed URLs instead of just the primary viewer URL. |
| `--open` | Open viewer URL in default browser after success. |

**Progress:** Show clear phases on stderr when TTY: `Converting…` → `Uploading…` → `Done.` so long `build-lod` runs don’t look hung.

---

## Hosted viewer page (the URL you share)

The URL returned by `sparkler host` should point at a **first-class viewer**, not a bare minimum canvas. It should feel like a **static share page** you’d send to collaborators or drop in a wiki.

### Navigation

- **Implemented:** Spark `SparkControls` power the full viewer with:
  - `W/A/S/D` move
  - `Shift` faster movement
  - `Q/E` roll left/right
  - `R/F` move up/down
  - drag to look
- **Mobile:** the full viewer includes a touch joystick (ported from `../grace`) plus drag-to-look.

### VR

- **Not implemented yet.** This remains a future target. The current viewer focuses on desktop/mobile movement and paged loading.

### View HUD / default view

- The full viewer currently ships a **default-view HUD** plus a separate bottom-left `i` controls toggle, rather than one final merged info/embed panel.
- It shows the live:
  - `position`
  - `target`
  - `quaternion`
- The user can click **Copy view** to copy JSON for the current camera pose.
- That JSON can then be persisted via:

```bash
sparkler set-view <sceneId> --view-file ./view.json
```

or:

```bash
sparkler set-view <sceneId> --view-json '{"position":[...],"target":[...],"quaternion":[...]}'
```

- On subsequent loads, `/s/:sceneId` and `/embed/:sceneId` use the saved **default view** before falling back to auto-fit / generic camera placement.

### Info panel: **`(i)`**

- **Partially implemented.** The current viewer has:
  - a bottom-left `i` toggle for movement controls
  - a separate default-view HUD for copying camera pose JSON and capturing a thumbnail
- A later combined panel could still absorb:
  - controls reminder
  - embed snippet
  - view/default thumbnail tools if a single panel feels cleaner

### Technical notes

- **`.rad` + paging:** Implemented. The viewer enables Spark’s paged loading path for `.rad` scenes and uses `pagedExtSplats: true` on the renderer.
- **Extended splats:** non-paged scenes explicitly use `extSplats`; paged RAD scenes use the renderer’s paged-ext-splats path.
- **Default view persistence:** scenes now support an optional persisted `defaultView` (`position`, `target`, optional `quaternion`).
- **Thumbnail capture:** implemented in the full viewer; owners can save a poster image to Tigris and the dashboard cards render it.
- **`/embed/:sceneId`:** remains the minimal iframe surface, but it also honors the persisted `defaultView`.

---

## Secondary commands

### `sparkler convert` (advanced)

Explicit **local-only** conversion; same as today. Use when debugging `build-lod`, batching, or custom flags **without** uploading.

```bash
sparkler convert scan.spz -o scan.rad -- --quality
```

### `sparkler embed-snippet <sceneId>` (advanced)

Still useful for **automation** and **CI**; for humans, a future in-view info/embed panel should eventually replace the current CLI-first snippet workflow.

### `sparkler dashboard` (small but useful)

Open the main Sparkler dashboard in the browser using the saved `deploymentUrl` from `sparkler login` (or `SPARKLER_DEPLOYMENT_URL` / config fallback).

**Synopsis**

```bash
sparkler dashboard
```

This is mostly a convenience command, but it makes the “CLI-first” flow smoother when you want to jump from a terminal task back into the web UI.

### `sparkler set-view <sceneId>` (advanced but very useful)

Persist the viewer’s **default camera pose** for a hosted scene.

**Synopsis**

```bash
sparkler set-view <sceneId> --view-file ./view.json
sparkler set-view <sceneId> --view-json '{"position":[...],"target":[...],"quaternion":[...]}'
```

**Behavior**

1. Authenticate like `host` / `list` / `del`.
2. Validate the copied JSON from the viewer HUD.
3. Save it to the scene’s `defaultView` metadata in Convex.
4. Future loads of `/s/:sceneId` and `/embed/:sceneId` start from that pose.

**Typical workflow**

1. Open the hosted viewer.
2. Move to the desired pose.
3. Click **Copy view** in the HUD.
4. Save the JSON to a file.
5. Run `sparkler set-view ...`.

---

## Managing hosted splats

These commands operate on **your** hosted scenes using the same identity mode as `host`: Clerk login, demo mode, or shared-secret admin automation. They keep the **library manageable** without opening the web UI.

### Access approval

Sparkler now separates **authentication** from **authorization**:

1. Clerk proves who the user is.
2. Sparkler provisions a `users` record keyed by Clerk subject/token identifier.
3. Admins approve or reject access in `/admin/access` (unless env-based allowlists auto-approve the user).
4. Protected CLI commands fail with a clear `pending approval` or `rejected` message until approval is granted.

### `sparkler list`

**Purpose:** Show everything you’ve uploaded under this identity.

**Synopsis**

```bash
sparkler list [options]
```

**Behavior**

1. Authenticate the same way as `host` (config from `login` or env).
2. Fetch scenes **owned by** the CLI user, **newest first** (same semantics as the app’s “your scenes,” but via HTTP or internal query exposed for CLI).
3. Print a **human table** by default; optional **JSON** for scripts.

**Default columns (TTY)**

| Column | Source |
|--------|--------|
| `id` | Convex `scenes` document id |
| `title` | Scene title |
| `visibility` | `public` / `unlisted` / `private` |
| `status` | `ready` / `pending_upload` / `failed` |
| `created` | ISO or relative time |
| `viewer` | Full viewer URL (`{deploymentUrl}/s/{id}`) — optional column or second line in `--verbose` |

**Options**

| Flag | Purpose |
|------|---------|
| `--json` | Print a JSON array of objects (`sceneId`, `title`, `visibility`, `status`, `createdAt`, `viewerUrl`, `embedUrl`, `filename`, `byteSize` if known). |
| `--limit <n>` | Cap rows (default e.g. 50, max enforced server-side). |
| `--all-status` | Include `failed` and `pending_upload` (default: show **ready** only, or show all with a note—pick one in implementation; document in `--help`). |

**Errors:** If auth is missing, exit with a clear message pointing at `sparkler login`, `--demo`, or the HTTP bearer env path.

---

### `sparkler del` (alias: `sparkler delete`)

**Purpose:** Remove a hosted splat **for good**: drop the **Tigris object** and the **Convex row** (or equivalent tombstone if you add soft-delete later—default design is **hard delete** for predictable storage billing).

**Synopsis**

```bash
sparkler del <sceneId>
sparkler delete <sceneId>
```

**Behavior**

1. Authenticate like `host` / `list`.
2. **Authorize:** scene must exist and **`ownerSubject` must match** the CLI identity; otherwise `403` / clear CLI error (do not leak existence of other users’ ids).
3. **Storage:** `DeleteObject` (or batch) on the scene’s `storageKey` via a **Convex internal action** (`"use node"` + AWS SDK), same credentials as presign.
4. **Database:** delete the `scenes` document (or patch to a `deleted` state + background cleanup—prefer **delete row + delete object** in v1 for simplicity).
5. Print confirmation: `Deleted <sceneId>` (or JSON `{ "ok": true, "sceneId": "..." }` with `--json`).

**Safety**

| Flag | Purpose |
|------|---------|
| *(default)* | If stdin is a TTY, require confirmation: `Delete <title> (y/N)?` unless `--yes`. |
| `--yes` / `-y` | Skip confirmation (CI / scripting). |

**Errors**

- Unknown id or not owned → non-zero exit, message like `Not found or access denied`.
- Storage delete fails → **do not** leave orphan objects: retry or surface error; if object delete fails after DB delete, log and document ops recovery (implementation detail).

**HTTP shape (for implementers)**

- `GET /cli/scenes?limit=&status=` — Bearer auth → JSON list.
- `DELETE /cli/scenes/:sceneId` or `POST /cli/delete` with body `{ "sceneId" }` — Bearer auth → delete flow above.

---

### `sparkler set-visibility <sceneId> <visibility>`

**Purpose:** Change an existing scene between `public`, `unlisted`, and `private` after upload.

**Synopsis**

```bash
sparkler set-visibility <sceneId> public
sparkler set-visibility <sceneId> unlisted
sparkler set-visibility <sceneId> private
```

**Behavior**

1. Authenticate like `host` / `list` / `del`.
2. Verify the scene is owned by the current identity.
3. Patch the scene’s `visibility` in Convex.
4. Print confirmation (or JSON with `--json`).

This fills the gap between “upload with initial visibility” and “later decide which scenes should appear in the gallery.”

---

### `sparkler adopt-demo-scenes`

**Purpose:** One-time migration for people who uploaded scenes before Clerk was configured and now want those demo-owned scenes attached to their real signed-in account.

**Synopsis**

```bash
sparkler adopt-demo-scenes
```

**Behavior**

1. Requires a real Clerk-backed `sparkler login`.
2. Reads `SPARKLER_DEMO_OWNER_SUBJECT` from Convex.
3. Moves scenes owned by that demo subject onto the authenticated Clerk subject in batches.
4. Prints how many scenes were adopted and whether more may remain.

**Design note:** This command intentionally refuses `--demo`. It exists specifically to bridge the no-auth bootstrap phase into a real authenticated account.

---

## Embedding (summary)

- **iframe URL:** `{deploymentUrl}/embed/{sceneId}`  
- **Discoverability:** today the CLI `embed-snippet` command is the supported embed workflow; a future in-view info/embed panel should make this more discoverable.

### Permissions & CSP

- **Public / unlisted:** embed works anonymously; Tigris CORS must allow the deployment origin.
- **Private:** tokenized embed URLs are a future enhancement; simple path assumes **unlisted** (link-only) or **public** as defaults.

---

## Configuration file / env

Example shape (fields may evolve with auth implementation):

```json
{
  "convexSiteUrl": "https://your-deployment.convex.site",
  "convexUrl": "https://your-deployment.convex.cloud",
  "deploymentUrl": "https://splats.example.com",
  "defaultVisibility": "unlisted",
  "demoMode": false
}
```

The CLI also auto-loads `.env` and `.env.local` from the current working directory. For no-auth dev mode, this is usually enough:

```dotenv
SPARKLER_DEMO=1
SPARKLER_CONVEX_URL=https://<deployment>.convex.cloud
SPARKLER_DEPLOYMENT_URL=http://localhost:5173
```

---

## Backend (Convex HTTP + Tigris)

- **Tigris** for blobs; **Convex** for metadata and presigned uploads.
- **Public CLI routes** under `https://<deployment>.convex.site/api/cli/...`:
  - Implemented: **me**, **upload session**, **finalize**, **mark-failed**, **list**, **delete**, **set-view**, **set-visibility**, **adopt-demo-scenes**.
- **Shared-secret admin automation routes** under `https://<deployment>.convex.site/cli/...`:
  - Implemented: **upload session**, **finalize**, **mark-failed**, **list**, **delete**, **set-view**, **set-visibility**.
- **Design principle:** CLI never holds Tigris keys for reads/writes of arbitrary buckets—presigned PUT for upload; **server-side delete** uses the same Convex-provisioned Tigris credentials as today’s presign path.

---

## Optional commands (later)

| Command | Purpose |
|---------|---------|
| `sparkler whoami` | Show logged-in identity / deployment URL. |
| `sparkler open <sceneId>` | Open viewer for an existing hosted scene in the browser. |

---

## Relation to `architecture.md`

- Storage and OLTP stay as today (Tigris + Convex).
- **Product emphasis:** the **share URL** is the main output; the **viewer route** is upgraded to a **full share experience** (WASD, VR, `(i)` + embed instructions), not only orbit + canvas.

---

## Summary

| User intent | Commands |
|-------------|----------|
| **“I want a link to my scan.”** | `sparkler login` → `sparkler host file.spz` |
| **“Open the web UI.”** | `sparkler dashboard` |
| **“Approve a new user.”** | Sign in as an admin → `/admin/access` |
| **“What have I uploaded?”** | `sparkler list` |
| **“Remove this one.”** | `sparkler del <sceneId>` |
| **“Make this one public.”** | `sparkler set-visibility <sceneId> public` |
| **“Start this scene from a good angle.”** | `Copy view` in `/s/:sceneId` → `sparkler set-view <sceneId> --view-file ./view.json` |
| **“Keep my old demo uploads.”** | `sparkler login` → `sparkler adopt-demo-scenes` |
| **“I only want a local .rad.”** | `sparkler convert …` |
| **“I need iframe HTML in CI.”** | `sparkler embed-snippet <id>` |

**Hosting should feel incredibly simple:** choose auth once (login, demo, or bearer), host any supported splat file, get back **one URL** that works well on desktop and mobile, then optionally save a polished default view with `sparkler set-view` and curate your library with `dashboard`, `list`, `set-visibility`, and `del`.
