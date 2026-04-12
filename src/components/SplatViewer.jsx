import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import * as THREE from "three";
import { SparkControls, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { api } from "../../convex/_generated/api";
import {
  disposeMobileControls,
  getMobileInput,
  initMobileControls,
  isMobileDevice,
  setMobileControlsEnabled,
} from "../lib/mobileJoystick.js";

const BASE_MOVE_SPEED = 1.5;
const SHIFT_MULTIPLIER = 4;
const viewerDebugEnabled =
  import.meta.env.DEV || import.meta.env.VITE_SPARKLER_DEBUG_VIEWER === "1";

function debugLog(sceneId, message, details) {
  if (!viewerDebugEnabled) {
    return;
  }
  const prefix = `[SplatViewer:${sceneId}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
  } else {
    console.log(prefix, details);
  }
}

function roundVec(vec, digits = 3) {
  return vec.map((value) => Number(value.toFixed(digits)));
}

function looksLikeRad(path) {
  if (!path || typeof path !== "string") return false;
  return path.toLowerCase().includes(".rad");
}

function fileExtension(pathLike) {
  if (!pathLike || typeof pathLike !== "string") {
    return null;
  }
  const cleaned = pathLike.split("#", 1)[0].split("?", 1)[0];
  const base = cleaned.split("/").pop() ?? cleaned;
  const i = base.lastIndexOf(".");
  if (i < 0 || i === base.length - 1) {
    return null;
  }
  return base.slice(i + 1).toLowerCase();
}

function inferSplatFileType(filename, url) {
  const ext = fileExtension(filename) ?? fileExtension(url);
  switch (ext) {
    case "ply":
    case "spz":
    case "splat":
    case "ksplat":
    case "sog":
    case "rad":
      return ext;
    default:
      return undefined;
  }
}

async function createThumbnailBlob(sourceCanvas) {
  if (!sourceCanvas || sourceCanvas.width < 1 || sourceCanvas.height < 1) {
    throw new Error("Viewer is not ready to capture a thumbnail yet");
  }

  const targetWidth = 640;
  const targetHeight = 360;
  const targetCanvas = document.createElement("canvas");
  targetCanvas.width = targetWidth;
  targetCanvas.height = targetHeight;
  const ctx = targetCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("Browser could not create a thumbnail canvas");
  }

  const sourceAspect = sourceCanvas.width / sourceCanvas.height;
  const targetAspect = targetWidth / targetHeight;
  let sx = 0;
  let sy = 0;
  let sw = sourceCanvas.width;
  let sh = sourceCanvas.height;

  if (sourceAspect > targetAspect) {
    sw = Math.round(sourceCanvas.height * targetAspect);
    sx = Math.max(0, Math.floor((sourceCanvas.width - sw) / 2));
  } else {
    sh = Math.round(sourceCanvas.width / targetAspect);
    sy = Math.max(0, Math.floor((sourceCanvas.height - sh) / 2));
  }

  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

  const blob = await new Promise((resolve, reject) => {
    try {
      targetCanvas.toBlob((value) => {
        if (value) {
          resolve(value);
        } else {
          reject(new Error("Browser could not encode thumbnail image"));
        }
      }, "image/jpeg", 0.88);
    } catch (error) {
      reject(error);
    }
  });

  return {
    blob,
    width: targetWidth,
    height: targetHeight,
    contentType: "image/jpeg",
  };
}

function applyMobileMovement(localFrame, deltaTime) {
  const mobile = getMobileInput();
  if (!mobile.active) {
    return;
  }
  const forward = new THREE.Vector3(0, 0, -1);
  const right = new THREE.Vector3(1, 0, 0);
  forward.applyQuaternion(localFrame.quaternion);
  right.applyQuaternion(localFrame.quaternion);
  forward.y = 0;
  right.y = 0;
  if (forward.lengthSq() > 0) forward.normalize();
  if (right.lengthSq() > 0) right.normalize();

  const velocity = new THREE.Vector3();
  velocity.addScaledVector(right, mobile.x);
  velocity.addScaledVector(forward, -mobile.y);
  if (velocity.lengthSq() > 0) {
    velocity.normalize().multiplyScalar(BASE_MOVE_SPEED * deltaTime * 3);
    localFrame.position.add(velocity);
  }
}

function getViewPose(localFrame) {
  const position = localFrame.position.clone();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(localFrame.quaternion);
  const target = position.clone().add(forward);
  return {
    position: roundVec(position.toArray()),
    target: roundVec(target.toArray()),
    quaternion: roundVec(localFrame.quaternion.toArray(), 4),
  };
}

function applyDefaultView({ defaultView, localFrame, camera, sceneId }) {
  if (
    !defaultView ||
    !Array.isArray(defaultView.position) ||
    defaultView.position.length < 3 ||
    (!Array.isArray(defaultView.target) || defaultView.target.length < 3) &&
      (!Array.isArray(defaultView.quaternion) || defaultView.quaternion.length < 4)
  ) {
    return false;
  }

  const position = new THREE.Vector3(...defaultView.position.slice(0, 3));
  localFrame.position.copy(position);
  if (Array.isArray(defaultView.quaternion) && defaultView.quaternion.length >= 4) {
    localFrame.quaternion.set(...defaultView.quaternion.slice(0, 4));
  } else {
    const target = new THREE.Vector3(...defaultView.target.slice(0, 3));
    localFrame.lookAt(target);
  }
  camera.near = 0.01;
  camera.far = 10000;
  camera.updateProjectionMatrix();
  debugLog(sceneId, "applied default view", {
    position: defaultView.position,
    target: defaultView.target,
    quaternion: defaultView.quaternion ?? null,
  });
  return true;
}

function fitCameraToSplat({ splatMesh, localFrame, camera, sceneId }) {
  let box;
  try {
    box = splatMesh.getBoundingBox();
  } catch (error) {
    debugLog(sceneId, "bounding box unavailable; keeping fallback camera", {
      error: error instanceof Error ? error.message : String(error),
    });
    localFrame.position.set(0, 1, 8);
    localFrame.lookAt(new THREE.Vector3(0, 0, 0));
    camera.near = 0.01;
    camera.far = 10000;
    camera.updateProjectionMatrix();
    return;
  }
  if (!box || box.isEmpty()) {
    debugLog(sceneId, "bounding box empty; keeping fallback camera");
    localFrame.position.set(0, 1, 8);
    localFrame.lookAt(new THREE.Vector3(0, 0, 0));
    camera.near = 0.01;
    camera.far = 10000;
    camera.updateProjectionMatrix();
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.5);
  const distance = Math.max(radius * 1.8, 2.5);

  localFrame.position.copy(center).add(new THREE.Vector3(0, radius * 0.15, distance));
  localFrame.lookAt(center);

  camera.near = Math.max(radius / 500, 0.01);
  camera.far = Math.max(radius * 50, 5000);
  camera.updateProjectionMatrix();

  debugLog(sceneId, "fit camera to splat", {
    center: center.toArray(),
    size: size.toArray(),
    radius,
    distance,
    near: camera.near,
    far: camera.far,
  });
}

/**
 * @param {{ sceneId: string; splatUrl: string | null; needsSignedUrl: boolean; filename?: string; minimal?: boolean; canEdit?: boolean; defaultView?: { position: number[]; target: number[]; quaternion?: number[] } | null }} props
 */
export default function SplatViewer({
  sceneId,
  splatUrl,
  needsSignedUrl,
  filename,
  minimal = false,
  canEdit = false,
  defaultView = null,
}) {
  const containerRef = useRef(null);
  const latestViewRef = useRef(null);
  const renderCanvasRef = useRef(null);
  const renderSnapshotRef = useRef(null);
  const presignView = useAction(api.tigris.presignView);
  const presignThumbnailUpload = useAction(api.tigris.presignThumbnailUpload);
  const saveSceneThumbnail = useMutation(api.scenes.saveSceneThumbnail);
  const [err, setErr] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [showViewHud, setShowViewHud] = useState(true);
  const [copyLabel, setCopyLabel] = useState("Copy view");
  const [thumbnailLabel, setThumbnailLabel] = useState("Capture thumbnail");
  const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const [currentView, setCurrentView] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    let cancelled = false;
    const cleanup = { fn: /** @type {null | (() => void)} */ (null) };

    (async () => {
      setErr("");
      let url = splatUrl;
      debugLog(sceneId, "effect start", {
        sceneId,
        filename,
        minimal,
        needsSignedUrl,
        initialSplatUrl: splatUrl,
      });
      if (needsSignedUrl || !url) {
        debugLog(sceneId, "requesting signed view url");
        try {
          const out = await presignView({ sceneId });
          url = out.url;
          debugLog(sceneId, "received signed view url", { url });
        } catch (e) {
          console.error(`[SplatViewer:${sceneId}] failed to presign view url`, e);
          if (!cancelled) setErr(e.message || String(e));
          return;
        }
      }
      if (!url || cancelled) {
        debugLog(sceneId, "aborting before renderer setup", {
          hasUrl: Boolean(url),
          cancelled,
        });
        return;
      }

      const rect = el.getBoundingClientRect();
      debugLog(sceneId, "container rect", {
        width: rect.width,
        height: rect.height,
      });
      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: canEdit,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(rect.width, rect.height, false);
      renderer.setClearColor(0x000000, 1);
      if (cancelled) {
        debugLog(sceneId, "cancelled after renderer creation");
        renderer.dispose();
        return;
      }
      el.appendChild(renderer.domElement);
      renderCanvasRef.current = renderer.domElement;

      const scene = new THREE.Scene();
      const mobileDevice = isMobileDevice();
      const spark = new SparkRenderer({
        renderer,
        pagedExtSplats: true,
        maxPagedSplats: mobileDevice ? 8_388_608 : 16_777_216,
        onDirty: () => {},
      });
      debugLog(sceneId, "created SparkRenderer", {
        pagedExtSplats: true,
        maxPagedSplats: mobileDevice ? 8_388_608 : 16_777_216,
      });
      scene.add(spark);

      const localFrame = new THREE.Group();
      scene.add(localFrame);

      const camera = new THREE.PerspectiveCamera(
        60,
        rect.width / Math.max(rect.height, 1),
        0.1,
        5000,
      );
      localFrame.position.set(0, 1, 4);
      camera.lookAt(0, 1, 3);
      localFrame.quaternion.copy(camera.quaternion);
      camera.rotation.set(0, 0, 0);
      localFrame.add(camera);

      const controls = new SparkControls({ canvas: renderer.domElement });
      controls.fpsMovement.enable = true;
      controls.fpsMovement.moveSpeed = BASE_MOVE_SPEED;
      controls.fpsMovement.shiftMultiplier = SHIFT_MULTIPLIER;
      controls.fpsMovement.keycodeMoveMapping = {
        ...controls.fpsMovement.keycodeMoveMapping,
        KeyR: new THREE.Vector3(0, 1, 0),
        KeyF: new THREE.Vector3(0, -1, 0),
      };
      delete controls.fpsMovement.keycodeMoveMapping.KeyQ;
      delete controls.fpsMovement.keycodeMoveMapping.KeyE;
      controls.fpsMovement.keycodeRotateMapping = {
        ...controls.fpsMovement.keycodeRotateMapping,
        KeyQ: new THREE.Vector3(0, 0, 1),
        KeyE: new THREE.Vector3(0, 0, -1),
      };
      controls.pointerControls.slideSpeed = 0;
      controls.pointerControls.scrollSpeed = 0;
      controls.pointerControls.pressMoveSpeed = 0;
      controls.pointerControls.doublePressMoveSpeed = 0;
      controls.pointerControls.triplePressMoveSpeed = 0;

      const mobileActive = mobileDevice && !minimal;
      debugLog(sceneId, "configured controls", {
        moveSpeed: controls.fpsMovement.moveSpeed,
        shiftMultiplier: controls.fpsMovement.shiftMultiplier,
        mobileDevice,
        mobileActive,
      });
      if (mobileActive) {
        initMobileControls();
        setMobileControlsEnabled(true);
        debugLog(sceneId, "enabled mobile joystick");
      }

      let splatMesh;
      try {
        const paged = looksLikeRad(filename) || looksLikeRad(url);
        const fileType = inferSplatFileType(filename, url);
        const meshOptions = {
          url,
          ...(fileType ? { fileType } : {}),
          lod: paged ? "quality" : true,
          paged,
          ...(paged ? {} : { extSplats: true }),
        };
        debugLog(sceneId, "creating SplatMesh", {
          ...meshOptions,
          filename,
        });
        splatMesh = new SplatMesh(meshOptions);
        splatMesh.quaternion.set(0, 0, 0, 1);
        scene.add(splatMesh);
        await splatMesh.initialized;
        if (
          !applyDefaultView({
            defaultView,
            localFrame,
            camera,
            sceneId,
          })
        ) {
          fitCameraToSplat({
            splatMesh,
            localFrame,
            camera,
            sceneId,
          });
        }
        debugLog(sceneId, "SplatMesh initialized", {
          paged,
          visible: splatMesh.visible,
        });
      } catch (e) {
        console.error(`[SplatViewer:${sceneId}] failed to create or initialize SplatMesh`, e);
        if (!cancelled) setErr(e.message || String(e));
        renderCanvasRef.current = null;
        spark.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        return;
      }

      if (cancelled) {
        debugLog(sceneId, "cancelled after mesh initialization");
        scene.remove(splatMesh);
        if (typeof splatMesh.dispose === "function") {
          splatMesh.dispose();
        }
        scene.remove(spark);
        spark.dispose();
        renderCanvasRef.current = null;
        renderer.dispose();
        if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        return;
      }

      function resize() {
        if (!el || cancelled) return;
        const r = el.getBoundingClientRect();
        renderer.setSize(r.width, r.height, false);
        camera.aspect = r.width / Math.max(r.height, 1);
        camera.updateProjectionMatrix();
        debugLog(sceneId, "resized", {
          width: r.width,
          height: r.height,
        });
      }
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      window.addEventListener("resize", resize);

      let raf = 0;
      let lastTime = performance.now();
      let lastHudUpdate = 0;
      function tick() {
        if (cancelled) return;
        raf = requestAnimationFrame(tick);
        const now = performance.now();
        const deltaTime = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;
        controls.update(localFrame, camera);
        if (mobileActive) {
          applyMobileMovement(localFrame, deltaTime);
        }
        if (!minimal) {
          latestViewRef.current = getViewPose(localFrame);
          if (now - lastHudUpdate > 150) {
            lastHudUpdate = now;
            setCurrentView(latestViewRef.current);
          }
        }
        renderer.render(scene, camera);
      }
      renderSnapshotRef.current = () => {
        controls.update(localFrame, camera);
        renderer.render(scene, camera);
        const gl = renderer.getContext();
        if (typeof gl.finish === "function") {
          gl.finish();
        }
      };
      tick();

      cleanup.fn = () => {
        debugLog(sceneId, "cleanup");
        cancelAnimationFrame(raf);
        ro.disconnect();
        window.removeEventListener("resize", resize);
        setMobileControlsEnabled(false);
        if (mobileActive) {
          disposeMobileControls();
        }
        if (splatMesh) {
          scene.remove(splatMesh);
          if (typeof splatMesh.dispose === "function") {
            splatMesh.dispose();
          }
        }
        localFrame.remove(camera);
        scene.remove(localFrame);
        scene.remove(spark);
        spark.dispose();
        renderSnapshotRef.current = null;
        renderCanvasRef.current = null;
        renderer.dispose();
        if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
      };
      if (cancelled) cleanup.fn();
    })();

    return () => {
      cancelled = true;
      debugLog(sceneId, "effect dispose");
      latestViewRef.current = null;
      renderSnapshotRef.current = null;
      renderCanvasRef.current = null;
      cleanup.fn?.();
    };
  }, [sceneId, splatUrl, needsSignedUrl, presignView, filename, minimal, defaultView, canEdit]);

  async function handleCopyView() {
    const payload = latestViewRef.current ?? currentView;
    if (!payload) {
      setCopyLabel("No view yet");
      window.setTimeout(() => setCopyLabel("Copy view"), 1200);
      return;
    }
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel("Copied");
    } catch {
      setCopyLabel("Copy failed");
    }
    window.setTimeout(() => setCopyLabel("Copy view"), 1200);
  }

  async function handleCaptureThumbnail() {
    if (!canEdit || thumbnailBusy) {
      return;
    }
    const sourceCanvas = renderCanvasRef.current;
    if (!sourceCanvas) {
      setThumbnailLabel("Viewer not ready");
      window.setTimeout(() => setThumbnailLabel("Capture thumbnail"), 1400);
      return;
    }

    setThumbnailBusy(true);
    setThumbnailLabel("Capturing...");

    try {
      renderSnapshotRef.current?.();
      const capture = await createThumbnailBlob(sourceCanvas);
      setThumbnailLabel("Uploading...");
      const { url, headers } = await presignThumbnailUpload({
        sceneId,
        contentType: capture.contentType,
        byteSize: capture.blob.size,
      });
      const putRes = await fetch(url, {
        method: "PUT",
        headers,
        body: capture.blob,
      });
      if (!putRes.ok) {
        throw new Error(`Thumbnail upload failed: ${putRes.status} ${putRes.statusText}`);
      }
      await saveSceneThumbnail({
        sceneId,
        contentType: capture.contentType,
        byteSize: capture.blob.size,
        width: capture.width,
        height: capture.height,
      });
      setThumbnailLabel("Saved thumbnail");
    } catch (error) {
      console.error(`[SplatViewer:${sceneId}] failed to capture thumbnail`, error);
      setThumbnailLabel("Thumbnail failed");
    } finally {
      setThumbnailBusy(false);
      window.setTimeout(() => setThumbnailLabel("Capture thumbnail"), 1600);
    }
  }

  return (
    <>
      {!minimal ? (
        <>
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              zIndex: 4,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={() => setShowViewHud((value) => !value)}
              style={{
                padding: "8px 10px",
                background: "rgba(0, 0, 0, 0.7)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                font: "12px/1.2 monospace",
                cursor: "pointer",
              }}
            >
              {showViewHud ? "Hide view HUD" : "Show view HUD"}
            </button>
            {showViewHud ? (
              <div
                style={{
                  minWidth: 280,
                  padding: "10px 12px",
                  background: "rgba(0, 0, 0, 0.72)",
                  color: "#fff",
                  font: "12px/1.45 monospace",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 8,
                  whiteSpace: "pre-wrap",
                }}
              >
                <div style={{ marginBottom: 8, fontWeight: 700 }}>Default View</div>
                <div>
                  position:{" "}
                  {currentView ? currentView.position.join(", ") : "waiting..."}
                </div>
                <div>
                  target: {currentView ? currentView.target.join(", ") : "waiting..."}
                </div>
                <div>
                  quaternion:{" "}
                  {currentView ? currentView.quaternion.join(", ") : "waiting..."}
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyView()}
                  style={{
                    marginTop: 10,
                    padding: "8px 10px",
                    background: "#1f1f1f",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 6,
                    font: "12px/1.2 monospace",
                    cursor: "pointer",
                  }}
                >
                  {copyLabel}
                </button>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => void handleCaptureThumbnail()}
                    disabled={thumbnailBusy}
                    style={{
                      marginTop: 8,
                      padding: "8px 10px",
                      background: thumbnailBusy ? "#101010" : "#1f1f1f",
                      color: "#fff",
                      border: "1px solid rgba(255,255,255,0.2)",
                      borderRadius: 6,
                      font: "12px/1.2 monospace",
                      cursor: thumbnailBusy ? "default" : "pointer",
                      opacity: thumbnailBusy ? 0.8 : 1,
                    }}
                  >
                    {thumbnailLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div
            style={{
              position: "absolute",
              left: 16,
              bottom: err ? 72 : 16,
              zIndex: 4,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            {showInfo ? (
              <div
                style={{
                  maxWidth: 320,
                  padding: "10px 12px",
                  background: "rgba(0, 0, 0, 0.72)",
                  color: "#fff",
                  font: "12px/1.45 monospace",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 8,
                  whiteSpace: "pre-wrap",
                }}
              >
                <div style={{ marginBottom: 8, fontWeight: 700 }}>Controls</div>
                <div>
                  {isMobileDevice()
                    ? "Joystick move\nDrag to look"
                    : "W/A/S/D move\nShift run\nQ/E roll\nR/F up/down\nDrag to look"}
                </div>
              </div>
            ) : null}
            <button
              type="button"
              aria-label={showInfo ? "Hide navigation help" : "Show navigation help"}
              onClick={() => setShowInfo((value) => !value)}
              style={{
                width: 36,
                height: 36,
                borderRadius: "999px",
                background: "rgba(0, 0, 0, 0.72)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.18)",
                font: "16px/1 monospace",
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
              }}
            >
              i
            </button>
          </div>
        </>
      ) : null}
      {err ? (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: 16,
            right: 16,
            color: "#f5a8a8",
            zIndex: 3,
            textAlign: "center",
          }}
        >
          {err}
        </div>
      ) : null}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
    </>
  );
}
