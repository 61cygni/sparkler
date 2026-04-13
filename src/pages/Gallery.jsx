import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import SceneGrid from "../components/SceneGrid.jsx";

export default function Gallery() {
  const publicScenes = useQuery(api.scenes.listPublicScenes, { limit: 48 });

  return (
    <div className="page">
      <h1 style={{ marginTop: 0 }}>Public scenes</h1>
      <p className="muted">Browse splats that have been shared publicly.</p>
      <SceneGrid
        scenes={publicScenes}
        loadingLabel="Loading…"
        emptyLabel="No public scenes yet."
        linkLabel="Open viewer"
        meta={(scene) => scene.filename}
      />
    </div>
  );
}
