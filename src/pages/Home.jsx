import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

const EMPTY_SCENES = [];

function useSignedThumbnailUrls(scenes) {
  const presignThumbnailUrls = useAction(api.tigris.presignThumbnailUrls);
  const [signedUrls, setSignedUrls] = useState({});
  const targets = useMemo(
    () =>
      scenes
        .filter((scene) => scene.thumbnail && scene.needsSignedThumbnail)
        .map((scene) => scene._id),
    [scenes],
  );
  const targetKey = targets.join("|");

  useEffect(() => {
    let cancelled = false;
    if (!targets.length) {
      setSignedUrls((prev) => (Object.keys(prev).length ? {} : prev));
      return undefined;
    }

    void presignThumbnailUrls({ sceneIds: targets })
      .then((rows) => {
        if (cancelled) {
          return;
        }
        const next = {};
        for (const row of rows) {
          next[row.sceneId] = row.url;
        }
        setSignedUrls(next);
      })
      .catch(() => {
        if (!cancelled) {
          setSignedUrls({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [presignThumbnailUrls, targetKey]);

  return signedUrls;
}

function resolveThumbnailSrc(scene, signedUrls) {
  if (scene.thumbnailUrl) {
    return scene.thumbnailUrl;
  }
  if (!scene.thumbnail) {
    return null;
  }
  const signedUrl = signedUrls[scene._id];
  if (!signedUrl) {
    return null;
  }
  return signedUrl;
}

function SceneCard({ scene, linkLabel, meta, signedUrls }) {
  const thumbnailSrc = resolveThumbnailSrc(scene, signedUrls);
  const href = `/s/${scene._id}`;

  return (
    <div className="card">
      <Link to={href} className="card-thumb-link" aria-label={`Open ${scene.title}`}>
        <div className="card-thumb">
          {thumbnailSrc ? (
            <img src={thumbnailSrc} alt={`${scene.title} thumbnail`} loading="lazy" />
          ) : (
            <div className="card-thumb-placeholder">
              {scene.status === "ready" ? "No thumbnail yet" : scene.status}
            </div>
          )}
        </div>
      </Link>
      <h3>{scene.title}</h3>
      <p className="muted" style={{ margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
        {meta}
      </p>
      <Link to={href}>{linkLabel}</Link>
    </div>
  );
}

export default function Home() {
  const accountStatus = useQuery(api.users.getMyAccountStatus);
  const publicScenes = useQuery(api.scenes.listPublicScenes, { limit: 48 });
  const myScenes = useQuery(api.scenes.listMyScenes, { limit: 50 });
  const publicSignedUrls = useSignedThumbnailUrls(publicScenes ?? EMPTY_SCENES);
  const mySignedUrls = useSignedThumbnailUrls(myScenes ?? EMPTY_SCENES);

  return (
    <div className="page">
      <h1 style={{ marginTop: 0 }}>Gaussian splat hosting</h1>
      <p className="muted">
        Upload <code>.spz</code>, <code>.ply</code>, and other Spark-supported formats. Powered by{" "}
        <a href="https://sparkjs.dev/" target="_blank" rel="noreferrer">
          Spark
        </a>{" "}
        + Convex + Tigris.
      </p>
      <p>
        <Link to="/upload">Upload a scene →</Link>
      </p>
      {accountStatus?.approvalStatus === "pending" ? (
        <p className="muted">
          Your account is pending approval. You can browse public scenes now, but uploads and CLI
          scene management stay blocked until an admin approves you.
        </p>
      ) : null}
      {accountStatus?.approvalStatus === "rejected" ? (
        <p className="muted">
          Your account was rejected. Contact a Sparkler admin if you still need access.
        </p>
      ) : null}

      <h2>Public scenes</h2>
      {publicScenes === undefined ? (
        <p className="muted">Loading…</p>
      ) : publicScenes.length === 0 ? (
        <p className="muted">No public scenes yet.</p>
      ) : (
        <div className="card-grid">
          {publicScenes.map((s) => (
            <SceneCard
              key={s._id}
              scene={s}
              meta={s.filename}
              linkLabel="Open viewer"
              signedUrls={publicSignedUrls}
            />
          ))}
        </div>
      )}

      <h2>Your scenes</h2>
      {myScenes === undefined ? (
        <p className="muted">Loading…</p>
      ) : myScenes.length === 0 ? (
        <p className="muted">No uploads yet (sign in or use demo owner in Convex).</p>
      ) : (
        <div className="card-grid">
          {myScenes.map((s) => (
            <SceneCard
              key={s._id}
              scene={s}
              meta={`${s.status} · ${s.visibility}`}
              linkLabel="Open"
              signedUrls={mySignedUrls}
            />
          ))}
        </div>
      )}
    </div>
  );
}
