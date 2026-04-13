import { useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import SplatViewer from "../components/SplatViewer.jsx";

export default function Embed() {
  const { sceneId } = useParams();
  const data = useQuery(api.scenes.getScene, { sceneId });

  if (data === undefined) {
    return (
      <div
        className="embed"
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#000",
          color: "#888",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Loading…
      </div>
    );
  }

  if (data === null || data.status !== "ready") {
    return (
      <div
        className="embed"
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#000",
          color: "#888",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Unavailable
      </div>
    );
  }

  return (
    <div className="viewer-wrap embed">
      <SplatViewer
        sceneId={data._id}
        splatUrl={data.splatUrl}
        needsSignedUrl={data.needsSignedUrl}
        filename={data.filename}
        title={data.title}
        defaultView={data.defaultView}
        minimal
      />
    </div>
  );
}
