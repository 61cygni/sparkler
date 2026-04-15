import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAction } from "convex/react";
import { Trash2 } from "lucide-react";
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

function SceneCard({ scene, linkLabel, meta, signedUrls, onDelete }) {
  const thumbnailSrc = resolveThumbnailSrc(scene, signedUrls);
  const href = `/s/${scene._id}`;

  return (
    <div className="card" style={{ position: "relative" }}>
      {onDelete && (
        <button
          className="card-delete-btn"
          aria-label={`Delete ${scene.title}`}
          onClick={() => {
            if (window.confirm(`Delete "${scene.title}"? This cannot be undone.`)) {
              onDelete(scene._id);
            }
          }}
        >
          <Trash2 size={16} />
        </button>
      )}
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

export default function SceneGrid({
  scenes,
  loadingLabel = "Loading…",
  emptyLabel = "No scenes yet.",
  linkLabel = "Open",
  meta,
  onDelete,
}) {
  const safeScenes = scenes ?? EMPTY_SCENES;
  const signedUrls = useSignedThumbnailUrls(safeScenes);

  if (scenes === undefined) {
    return <p className="muted">{loadingLabel}</p>;
  }

  if (scenes.length === 0) {
    return <p className="muted">{emptyLabel}</p>;
  }

  return (
    <div className="card-grid">
      {scenes.map((scene) => (
        <SceneCard
          key={scene._id}
          scene={scene}
          meta={meta(scene)}
          linkLabel={linkLabel}
          signedUrls={signedUrls}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
