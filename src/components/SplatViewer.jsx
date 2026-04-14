import { useEffect, useMemo, useRef, useState } from "react";
import GUI from "lil-gui";
import {
  CircleHelp,
  Crosshair,
  Ellipsis,
  House,
  Share2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAction, useMutation } from "convex/react";
import * as THREE from "three";
import { SparkControls, SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";
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
const XR_TURN_DEADZONE = 0.1;
const XR_TURN_SPEED = 1.5;
const viewerDebugEnabled =
  import.meta.env.DEV || import.meta.env.VITE_SPARKLER_DEBUG_VIEWER === "1";
const DEFAULT_BACKGROUND = 0x000000;
const XR_WORLD_Y_AXIS = new THREE.Vector3(0, 1, 0);
const XR_TURN_QUAT = new THREE.Quaternion();
const XR_TURN_AXIS = new THREE.Vector3();
const HELP_DESKTOP_CONTROLS = [
  ["Click and drag", "Look around", true],
  ["[W][A][S][D]", "Move", true],
  ["[Q][E]", "Roll", false],
  ["[R][F]", "Up / down", false],
  ["+ Shift", "Run", false],
];
const HELP_MOBILE_CONTROLS = [
  ["Swipe", "Look around", true],
  ["Joystick", "Move", true],
  ["Pinch", "Zoom", false],
];

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

function printLog(sceneId, message, details) {
  const prefix = `[SplatViewer:${sceneId}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
  } else {
    console.log(prefix, details);
  }
}

function printJsonLine(sceneId, message, value) {
  const prefix = `[SplatViewer:${sceneId}] ${message}`;
  try {
    console.log(`${prefix} ${JSON.stringify(value)}`);
  } catch (error) {
    console.log(`${prefix} ${String(value)}`);
    console.error(`[SplatViewer:${sceneId}] failed to stringify log payload`, error);
  }
}

function safeDispose(sceneId, label, value) {
  if (!value || typeof value.dispose !== "function") {
    return;
  }
  try {
    const result = value.dispose();
    if (result && typeof result.then === "function") {
      void result.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Worker terminate")) {
          debugLog(sceneId, `${label} dispose ignored worker termination`, { message });
          return;
        }
        console.error(`[SplatViewer:${sceneId}] ${label} dispose failed`, error);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Worker terminate")) {
      debugLog(sceneId, `${label} dispose ignored worker termination`, { message });
      return;
    }
    console.error(`[SplatViewer:${sceneId}] ${label} dispose failed`, error);
  }
}

function roundVec(vec, digits = 3) {
  return vec.map((value) => Number(value.toFixed(digits)));
}

function parseCsvNumbers(value, expectedLength) {
  if (!value) {
    return null;
  }
  const values = value
    .split(",")
    .map((item) => Number(item.trim()))
    .slice(0, expectedLength);
  if (values.length !== expectedLength || values.some((item) => !Number.isFinite(item))) {
    return null;
  }
  return values;
}

function parseBooleanParam(value, fallback) {
  if (value === null) {
    return fallback;
  }
  return value === "1" || value === "true";
}

function parseHexColor(value) {
  if (!value) {
    return DEFAULT_BACKGROUND;
  }
  const cleaned = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return Number.parseInt(cleaned, 16);
  }
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const expanded = cleaned
      .split("")
      .map((char) => `${char}${char}`)
      .join("");
    return Number.parseInt(expanded, 16);
  }
  return DEFAULT_BACKGROUND;
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

function parseViewerOptions(search, isViewMode) {
  const params = new URLSearchParams(search);
  const startPos = parseCsvNumbers(params.get("startPos"), 3);
  const startQuat = parseCsvNumbers(params.get("startQuat"), 4);
  const orient = parseCsvNumbers(params.get("orient"), 4);
  const scale = Number(params.get("scale") ?? 1);
  const lodSplatScale = Number(params.get("lodSplatScale") ?? "");
  const splatLimit = Number(params.get("splatLimit") ?? "");
  const moveSpeed = Number(params.get("moveSpeed") ?? BASE_MOVE_SPEED);
  const coneFov0 = Number(params.get("coneFov0") ?? 70);
  const coneFov = Number(params.get("coneFov") ?? 120);
  const coneFoveate = Number(params.get("coneFoveate") ?? 0.4);
  const behindFoveate = Number(params.get("behindFoveate") ?? 0.2);

  return {
    backgroundColor: parseHexColor(params.get("backgroundColor")),
    debug: parseBooleanParam(params.get("debug"), false),
    highDpi: parseBooleanParam(params.get("highDpi"), true),
    orient,
    moveSpeed: Number.isFinite(moveSpeed) && moveSpeed > 0 ? moveSpeed : BASE_MOVE_SPEED,
    reverseLook: parseBooleanParam(params.get("reverseLook"), isMobileDevice()),
    reverseSlide: parseBooleanParam(params.get("reverseSlide"), isMobileDevice()),
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    lodSplatScale: Number.isFinite(lodSplatScale) && lodSplatScale > 0 ? lodSplatScale : null,
    coneFov0: Number.isFinite(coneFov0) ? coneFov0 : 70,
    coneFov: Number.isFinite(coneFov) ? coneFov : 120,
    coneFoveate: Number.isFinite(coneFoveate) ? coneFoveate : 0.4,
    behindFoveate: Number.isFinite(behindFoveate) ? behindFoveate : 0.2,
    splatLimit: Number.isFinite(splatLimit) && splatLimit > 0 ? splatLimit : null,
    startPose:
      startPos && startQuat
        ? {
            position: startPos,
            quaternion: startQuat,
          }
        : null,
    useJoystick: parseBooleanParam(params.get("useJoystick"), isMobileDevice()),
    usePressMove: parseBooleanParam(params.get("usePressMove"), true),
  };
}

function applyXrYawTurn(localFrame, renderer, deltaTime, turnAxis = XR_WORLD_Y_AXIS) {
  if (!renderer.xr.isPresenting) {
    return;
  }
  const session = renderer.xr.getSession();
  if (!session) {
    return;
  }

  let yaw = 0;
  for (const source of session.inputSources) {
    const gamepad = source.gamepad;
    if (!gamepad || source.handedness !== "right") {
      continue;
    }
    const rawYaw = gamepad.axes[2] ?? 0;
    if (Math.abs(rawYaw) > XR_TURN_DEADZONE) {
      yaw = rawYaw;
      break;
    }
  }

  if (yaw === 0) {
    return;
  }

  const yawAmount = -yaw * XR_TURN_SPEED * deltaTime;
  XR_TURN_AXIS.copy(turnAxis);
  if (XR_TURN_AXIS.lengthSq() < 1e-8) {
    XR_TURN_AXIS.copy(XR_WORLD_Y_AXIS);
  } else {
    XR_TURN_AXIS.normalize();
  }
  XR_TURN_QUAT.setFromAxisAngle(XR_TURN_AXIS, yawAmount);
  localFrame.quaternion.premultiply(XR_TURN_QUAT);
  localFrame.quaternion.normalize();
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

function getExactViewPose(localFrame) {
  const position = localFrame.position.clone();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(localFrame.quaternion);
  const target = position.clone().add(forward);
  return {
    position: position.toArray(),
    target: target.toArray(),
    quaternion: localFrame.quaternion.clone().normalize().toArray(),
  };
}

function defaultViewToPose(defaultView) {
  if (
    !defaultView ||
    !Array.isArray(defaultView.position) ||
    defaultView.position.length < 3 ||
    ((!Array.isArray(defaultView.target) || defaultView.target.length < 3) &&
      (!Array.isArray(defaultView.quaternion) || defaultView.quaternion.length < 4))
  ) {
    return null;
  }

  const position = new THREE.Vector3(...defaultView.position.slice(0, 3));
  const quaternion = new THREE.Quaternion();
  if (Array.isArray(defaultView.quaternion) && defaultView.quaternion.length >= 4) {
    quaternion.set(...defaultView.quaternion.slice(0, 4)).normalize();
  } else {
    const localFrame = new THREE.Object3D();
    localFrame.position.copy(position);
    localFrame.lookAt(new THREE.Vector3(...defaultView.target.slice(0, 3)));
    quaternion.copy(localFrame.quaternion).normalize();
  }

  return {
    position: position.toArray(),
    quaternion: quaternion.toArray(),
  };
}

function formatNumberArray(values, digits = 4) {
  return values.map((value) => Number(value.toFixed(digits)).toString()).join(",");
}

function applyPose(localFrame, camera, pose) {
  if (!pose) {
    return;
  }
  localFrame.position.set(...pose.position.slice(0, 3));
  localFrame.quaternion.set(...pose.quaternion.slice(0, 4)).normalize();
  camera.near = 0.01;
  camera.far = 10000;
  camera.updateProjectionMatrix();
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
 * @param {{ sceneId: string; splatUrl: string | null; needsSignedUrl: boolean; filename?: string; title?: string; viewerMode?: "view" | "normal" | "owner"; defaultView?: { position: number[]; target: number[]; quaternion?: number[] } | null; sceneAudio?: { background?: { filename: string; contentType: string; byteSize: number; volume?: number; loop?: boolean } | null; positional?: Array<{ id: string; filename: string; contentType: string; byteSize: number; position: number[]; volume?: number; loop?: boolean; refDistance?: number; maxDistance?: number; rolloffFactor?: number }> } | null }} props
 */
export default function SplatViewer({
  sceneId,
  splatUrl,
  needsSignedUrl,
  filename,
  title,
  viewerMode = "normal",
  defaultView = null,
  sceneAudio = null,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const isViewMode = viewerMode === "view";
  const isOwnerMode = viewerMode === "owner";
  const showControlChrome = !isViewMode;
  const showHomeButton = !isViewMode;
  const showOwnerTools = isOwnerMode;
  const showHelpButton = true;
  const showResetButton = !isViewMode;
  const showShareButton = !isViewMode;
  const viewerOptions = useMemo(
    () => parseViewerOptions(location.search, isViewMode),
    [location.search, isViewMode],
  );
  const savedDefaultPose = useMemo(() => defaultViewToPose(defaultView), [defaultView]);
  const displayLabel = filename || title || "";
  const containerRef = useRef(null);
  const latestViewRef = useRef(null);
  const latestExactViewRef = useRef(null);
  const startupPoseLoggedRef = useRef(false);
  const resetPoseRef = useRef(null);
  const resetViewRef = useRef(() => {});
  const shareConfigRef = useRef(null);
  const renderCanvasRef = useRef(null);
  const renderSnapshotRef = useRef(null);
  const playAudioRef = useRef(async () => false);
  const stopAudioRef = useRef(() => {});
  const xrRef = useRef(null);
  const xrTurnAxisRef = useRef(XR_WORLD_Y_AXIS.clone());
  const presignView = useAction(api.tigris.presignView);
  const resolveSceneAudio = useAction(api.tigris.resolveSceneAudio);
  const presignThumbnailUpload = useAction(api.tigris.presignThumbnailUpload);
  const saveSceneThumbnail = useMutation(api.scenes.saveSceneThumbnail);
  const updateSceneDefaultView = useMutation(api.scenes.updateSceneDefaultView);
  const [err, setErr] = useState("");
  const [showHelpOverlay, setShowHelpOverlay] = useState(false);
  const [showToolsOverlay, setShowToolsOverlay] = useState(false);
  const [mobileHelpMode, setMobileHelpMode] = useState(isMobileDevice());
  const [copyLabel, setCopyLabel] = useState("Copy view");
  const [shareLabel, setShareLabel] = useState("Share link");
  const [shareToast, setShareToast] = useState("");
  const [saveViewLabel, setSaveViewLabel] = useState("Set current view");
  const [thumbnailLabel, setThumbnailLabel] = useState("Capture thumbnail");
  const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const [saveViewBusy, setSaveViewBusy] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [xrSupported, setXrSupported] = useState(false);
  const [xrPresenting, setXrPresenting] = useState(false);
  const [currentView, setCurrentView] = useState(null);
  const hasSceneAudio = Boolean(sceneAudio?.background || sceneAudio?.positional?.length);
  const allowAudioToggle = hasSceneAudio;
  const showXrButton = xrSupported || xrPresenting;
  const showLeftControls =
    showHomeButton ||
    showHelpButton ||
    showResetButton ||
    showShareButton ||
    allowAudioToggle ||
    showXrButton ||
    showOwnerTools;

  useEffect(() => {
    setShowHelpOverlay(false);
    setShowToolsOverlay(false);
    setMobileHelpMode(isMobileDevice());
    setShareLabel("Share link");
    setShareToast("");
    setSaveViewLabel("Set current view");
    startupPoseLoggedRef.current = false;
    setAudioEnabled(false);
    setXrSupported(false);
    setXrPresenting(false);
    xrTurnAxisRef.current.copy(XR_WORLD_Y_AXIS);
  }, [sceneId, viewerMode]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    let cancelled = false;
    const cleanup = { fn: /** @type {null | (() => void)} */ (null) };

    (async () => {
      setErr("");
      let url = splatUrl;
      let resolvedAudio = null;
      debugLog(sceneId, "effect start", {
        sceneId,
        filename,
        viewerMode,
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
      if (hasSceneAudio) {
        try {
          resolvedAudio = await resolveSceneAudio({ sceneId });
        } catch (e) {
          console.error(`[SplatViewer:${sceneId}] failed to resolve audio urls`, e);
        }
      }

      const rect = el.getBoundingClientRect();
      debugLog(sceneId, "container rect", {
        width: rect.width,
        height: rect.height,
      });
      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: isOwnerMode,
      });
      renderer.setPixelRatio(viewerOptions.highDpi ? Math.min(window.devicePixelRatio, 2) : 1);
      renderer.setSize(rect.width, rect.height, false);
      renderer.setClearColor(viewerOptions.backgroundColor, 1);
      if (cancelled) {
        debugLog(sceneId, "cancelled after renderer creation");
        renderer.dispose();
        return;
      }
      el.appendChild(renderer.domElement);
      renderCanvasRef.current = renderer.domElement;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(viewerOptions.backgroundColor);
      const mobileDevice = isMobileDevice();
      const maxStdDev = mobileDevice ? Math.sqrt(5) : Math.sqrt(8);
      const spark = new SparkRenderer({
        renderer,
        maxStdDev,
        pagedExtSplats: true,
        maxPagedSplats: mobileDevice ? 8_388_608 : 16_777_216,
        onDirty: () => {},
        lodSplatScale: 1,
        lodInflate: true,
        coneFov0: viewerOptions.coneFov0,
        coneFov: viewerOptions.coneFov,
        coneFoveate: viewerOptions.coneFoveate,
        behindFoveate: viewerOptions.behindFoveate,
        blurAmount: 0.3,
      });
      debugLog(sceneId, "created SparkRenderer", {
        pagedExtSplats: true,
        maxPagedSplats: mobileDevice ? 8_388_608 : 16_777_216,
      });
      if (viewerOptions.splatLimit && spark.defaultSplatTarget() > viewerOptions.splatLimit) {
        spark.lodSplatScale = viewerOptions.splatLimit / spark.defaultSplatTarget();
      }
      if (viewerOptions.lodSplatScale) {
        spark.lodSplatScale = viewerOptions.lodSplatScale;
      }
      spark.enableLodFetching = true;
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
      let audioListener = null;
      let backgroundAudio = null;
      const positionalAudioNodes = [];

      if (resolvedAudio?.background || resolvedAudio?.positional?.length) {
        try {
          if (resolvedAudio.positional?.length) {
            audioListener = new THREE.AudioListener();
            camera.add(audioListener);
            const loader = new THREE.AudioLoader();
            for (const item of resolvedAudio.positional) {
              const holder = new THREE.Object3D();
              holder.position.set(...item.position.slice(0, 3));
              const positionalAudio = new THREE.PositionalAudio(audioListener);
              const buffer = await loader.loadAsync(item.url);
              positionalAudio.setBuffer(buffer);
              positionalAudio.setLoop(item.loop ?? true);
              positionalAudio.setVolume(item.volume ?? 1);
              positionalAudio.setRefDistance(item.refDistance ?? 1);
              positionalAudio.setMaxDistance(item.maxDistance ?? 100);
              positionalAudio.setRolloffFactor(item.rolloffFactor ?? 1);
              holder.add(positionalAudio);
              scene.add(holder);
              positionalAudioNodes.push({ holder, audio: positionalAudio });
            }
          }
          if (resolvedAudio.background?.url) {
            backgroundAudio = new Audio(resolvedAudio.background.url);
            backgroundAudio.preload = "auto";
            backgroundAudio.loop = resolvedAudio.background.loop ?? true;
            backgroundAudio.volume = resolvedAudio.background.volume ?? 1;
            backgroundAudio.crossOrigin = "anonymous";
            backgroundAudio.playsInline = true;
          }
        } catch (error) {
          console.error(`[SplatViewer:${sceneId}] failed to initialize audio`, error);
          if (audioListener) {
            camera.remove(audioListener);
            audioListener = null;
          }
          if (backgroundAudio) {
            backgroundAudio.pause();
            backgroundAudio = null;
          }
          for (const item of positionalAudioNodes) {
            item.holder.remove(item.audio);
            scene.remove(item.holder);
          }
          positionalAudioNodes.length = 0;
        }
      }

      playAudioRef.current = async () => {
        let started = false;
        if (audioListener?.context?.state === "suspended") {
          await audioListener.context.resume();
        }
        for (const item of positionalAudioNodes) {
          if (item.audio.buffer && !item.audio.isPlaying) {
            item.audio.play();
            started = true;
          }
        }
        if (backgroundAudio) {
          await backgroundAudio.play();
          started = true;
        }
        return started;
      };
      stopAudioRef.current = () => {
        if (backgroundAudio) {
          backgroundAudio.pause();
          backgroundAudio.currentTime = 0;
        }
        for (const item of positionalAudioNodes) {
          if (item.audio.isPlaying) {
            item.audio.stop();
          }
        }
      };

      const controls = new SparkControls({ canvas: renderer.domElement });
      controls.fpsMovement.enable = true;
      controls.fpsMovement.moveSpeed = viewerOptions.moveSpeed;
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
      controls.pointerControls.reverseRotate = viewerOptions.reverseLook;
      controls.pointerControls.reverseScroll = viewerOptions.reverseLook;
      controls.pointerControls.reverseSlide = viewerOptions.reverseSlide;
      controls.pointerControls.reverseSwipe = viewerOptions.reverseSlide;

      const movementState = {
        value: viewerOptions.useJoystick && mobileDevice,
      };
      const pressMoveState = {
        value: viewerOptions.usePressMove,
      };
      const moveSpeedState = {
        value: viewerOptions.moveSpeed,
      };
      const reverseLookState = {
        value: viewerOptions.reverseLook,
      };
      const reverseSlideState = {
        value: viewerOptions.reverseSlide,
      };
      const mobileControlsAvailable = mobileDevice && showControlChrome;
      debugLog(sceneId, "configured controls", {
        moveSpeed: controls.fpsMovement.moveSpeed,
        shiftMultiplier: controls.fpsMovement.shiftMultiplier,
        mobileDevice,
        mobileControlsAvailable,
      });
      if (mobileControlsAvailable) {
        initMobileControls();
        setMobileControlsEnabled(movementState.value && mobileDevice);
        debugLog(sceneId, "enabled mobile joystick");
      } else {
        setMobileControlsEnabled(false);
      }

      const xrElement = document.createElement("button");
      xrElement.type = "button";
      xrElement.tabIndex = -1;
      xrElement.setAttribute("aria-hidden", "true");
      xrElement.style.position = "absolute";
      xrElement.style.width = "0";
      xrElement.style.height = "0";
      xrElement.style.padding = "0";
      xrElement.style.margin = "0";
      xrElement.style.border = "0";
      xrElement.style.opacity = "0";
      xrElement.style.pointerEvents = "none";
      xrElement.style.overflow = "hidden";
      el.appendChild(xrElement);

      const xr = new SparkXr({
        renderer,
        element: xrElement,
        mode: "vr",
        frameBufferScaleFactor: 0.75,
        referenceSpaceType: "local-floor",
        controllers: {
          moveSpeed: moveSpeedState.value,
          getRotate: () => new THREE.Vector3(0, 0, 0),
        },
        onReady: (supported) => {
          if (!cancelled) {
            setXrSupported(Boolean(supported));
          }
        },
        onEnterXr: () => {
          if (!cancelled) {
            xrTurnAxisRef.current.copy(XR_WORLD_Y_AXIS).applyQuaternion(localFrame.quaternion).normalize();
            setXrPresenting(true);
            setShareToast("Entered VR");
            window.setTimeout(() => setShareToast(""), 1400);
          }
        },
        onExitXr: () => {
          if (!cancelled) {
            xrTurnAxisRef.current.copy(XR_WORLD_Y_AXIS);
            setXrPresenting(false);
            setShareToast("Exited VR");
            window.setTimeout(() => setShareToast(""), 1400);
          }
        },
      });
      xrRef.current = xr;

      let gui = null;
      let guiState = null;

      function updateMoveSpeed() {
        controls.fpsMovement.moveSpeed = moveSpeedState.value;
        if (xr.controllers) {
          xr.controllers.moveSpeed = moveSpeedState.value;
        }
        controls.pointerControls.slideSpeed = 0.006 * moveSpeedState.value;
        controls.pointerControls.scrollSpeed = 0.0015 * moveSpeedState.value;
        const pressMoveSpeed = pressMoveState.value ? moveSpeedState.value : 0;
        controls.pointerControls.pressMoveDelayMs = 400;
        controls.pointerControls.pressMoveSpeed = pressMoveSpeed;
        controls.pointerControls.doublePressMoveSpeed = pressMoveSpeed * 3;
        controls.pointerControls.triplePressMoveSpeed = pressMoveSpeed * 10;
      }

      function syncShareConfig(splatMeshInstance = splatMesh) {
        shareConfigRef.current = {
          path: location.pathname,
          options: {
            backgroundColor: viewerOptions.backgroundColor,
            moveSpeed: moveSpeedState.value,
            reverseLook: reverseLookState.value,
            reverseSlide: reverseSlideState.value,
            useJoystick: movementState.value,
            usePressMove: pressMoveState.value,
            highDpi: guiState?.highDpi ?? viewerOptions.highDpi,
            coneFov0: spark.coneFov0,
            coneFov: spark.coneFov,
            coneFoveate: spark.coneFoveate,
            behindFoveate: spark.behindFoveate,
            lodSplatScale: spark.lodSplatScale,
            scale: splatMeshInstance?.scale?.x ?? viewerOptions.scale,
            orient: splatMeshInstance?.quaternion?.toArray?.() ?? viewerOptions.orient,
          },
        };
      }

      updateMoveSpeed();
      const initialPose = viewerOptions.startPose ?? savedDefaultPose;
      printLog(sceneId, "initial pose resolution", {
        defaultView,
        savedDefaultPose,
        urlStartPose: viewerOptions.startPose,
        chosenSource: viewerOptions.startPose
          ? "url"
          : savedDefaultPose
            ? "savedDefaultView"
            : "fitCamera",
        initialPose,
      });
      printJsonLine(sceneId, "initial pose resolution.defaultView", defaultView);
      printJsonLine(sceneId, "initial pose resolution.savedDefaultPose", savedDefaultPose);
      printJsonLine(sceneId, "initial pose resolution.urlStartPose", viewerOptions.startPose);
      printJsonLine(
        sceneId,
        "initial pose resolution.chosenSource",
        viewerOptions.startPose ? "url" : savedDefaultPose ? "savedDefaultView" : "fitCamera",
      );
      printJsonLine(sceneId, "initial pose resolution.initialPose", initialPose);

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
        printLog(sceneId, "mesh creation settings", {
          ...meshOptions,
          filename,
          scale: viewerOptions.scale,
          orient: viewerOptions.orient ?? null,
        });
        splatMesh = new SplatMesh(meshOptions);
        if (viewerOptions.orient) {
          splatMesh.quaternion.copy(new THREE.Quaternion(...viewerOptions.orient).normalize());
        }
        splatMesh.scale.setScalar(viewerOptions.scale);
        scene.add(splatMesh);
        await splatMesh.initialized;
        if (initialPose) {
          applyPose(localFrame, camera, initialPose);
          debugLog(sceneId, "applied initial pose", {
            source: viewerOptions.startPose ? "url" : "savedDefaultView",
            pose: initialPose,
          });
          printJsonLine(sceneId, "startup pose after applyPose.localFrame", getExactViewPose(localFrame));
          printJsonLine(sceneId, "startup pose after applyPose.cameraWorldPosition", {
            position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
            quaternion: camera.getWorldQuaternion(new THREE.Quaternion()).toArray(),
          });
        } else {
          fitCameraToSplat({
            splatMesh,
            localFrame,
            camera,
            sceneId,
          });
        }
        resetPoseRef.current = getExactViewPose(localFrame);
        resetViewRef.current = () => {
          if (!resetPoseRef.current) {
            return;
          }
          applyPose(localFrame, camera, resetPoseRef.current);
          latestViewRef.current = getViewPose(localFrame);
          latestExactViewRef.current = getExactViewPose(localFrame);
          setCurrentView(latestViewRef.current);
          syncShareConfig(splatMesh);
          renderer.render(scene, camera);
        };
        latestViewRef.current = getViewPose(localFrame);
        latestExactViewRef.current = getExactViewPose(localFrame);
        setCurrentView(latestViewRef.current);
        syncShareConfig(splatMesh);
        if (showControlChrome) {
          guiState = {
            activeSplats: 0,
            highDpi: viewerOptions.highDpi,
            lodSplatScale: spark.lodSplatScale,
          };
          gui = new GUI({ title: "Controls" }).close();

          const movementFolder = gui.addFolder("Movement");
          movementFolder
            .add(movementState, "value")
            .name("Use mobile joystick")
            .onChange((value) => {
              setMobileControlsEnabled(Boolean(value) && mobileDevice);
            });
          movementFolder
            .add(pressMoveState, "value")
            .name("Press+hold to move")
            .onChange((value) => {
              updateMoveSpeed();
            });
          movementFolder
            .add(moveSpeedState, "value", 0.1, 5.0, 0.1)
            .name("Move speed")
            .onChange((value) => {
              updateMoveSpeed();
            });
          movementFolder
            .add(reverseLookState, "value")
            .name("Reverse look")
            .onChange((value) => {
              controls.pointerControls.reverseRotate = value;
              controls.pointerControls.reverseScroll = value;
            });
          movementFolder
            .add(reverseSlideState, "value")
            .name("Reverse slide")
            .onChange((value) => {
              controls.pointerControls.reverseSlide = value;
              controls.pointerControls.reverseSwipe = value;
              controls.pointerControls.reverseScroll = value;
            });

          const lodFolder = gui.addFolder("LoD").close();
          lodFolder.add(guiState, "activeSplats").name("# active splats").listen();
          lodFolder
            .add(spark, "lodSplatScale", 0.001, 2.0, 0.001)
            .name("LoD detail")
            .listen()
            .onChange(() => {
              spark.lodDirty = true;
            });
          lodFolder
            .add(spark, "coneFov0", 0, 120, 1)
            .name("Cone Fov 0")
            .listen()
            .onChange(() => {
              spark.coneFov = Math.max(spark.coneFov0, spark.coneFov);
              spark.lodDirty = true;
            });
          lodFolder
            .add(spark, "coneFov", 0, 120, 1)
            .name("Cone Fov")
            .listen()
            .onChange(() => {
              spark.coneFov0 = Math.min(spark.coneFov0, spark.coneFov);
              spark.lodDirty = true;
            });
          lodFolder
            .add(spark, "coneFoveate", 0.005, 1.0, 0.001)
            .name("Cone Foveate")
            .listen()
            .onChange(() => {
              spark.behindFoveate = Math.min(spark.coneFoveate, spark.behindFoveate);
              spark.lodDirty = true;
            });
          lodFolder
            .add(spark, "behindFoveate", 0.005, 1.0, 0.001)
            .name("Behind Foveate")
            .listen()
            .onChange(() => {
              spark.coneFoveate = Math.max(spark.coneFoveate, spark.behindFoveate);
              spark.lodDirty = true;
            });
          lodFolder
            .add(guiState, "highDpi")
            .name("High DPI")
            .listen()
            .onChange((value) => {
              renderer.setPixelRatio(value ? Math.min(window.devicePixelRatio, 2) : 1);
              resize();
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
        safeDispose(sceneId, "spark", spark);
        renderer.dispose();
        if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        return;
      }

      if (cancelled) {
        debugLog(sceneId, "cancelled after mesh initialization");
        scene.remove(splatMesh);
        safeDispose(sceneId, "splatMesh", splatMesh);
        scene.remove(spark);
        safeDispose(sceneId, "spark", spark);
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

      let lastTime = performance.now();
      let lastHudUpdate = 0;
      function renderFrame(time = performance.now(), xrFrame = undefined) {
        if (cancelled) return;
        const now = Number.isFinite(time) ? Number(time) : performance.now();
        const deltaTime = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;
        if (xrPresenting || renderer.xr.isPresenting) {
          xr.updateControllers(camera);
          applyXrYawTurn(localFrame, renderer, deltaTime, xrTurnAxisRef.current);
        }
        controls.update(localFrame, camera);
        if (!startupPoseLoggedRef.current) {
          startupPoseLoggedRef.current = true;
          printJsonLine(sceneId, "startup pose first tick.localFrame", getExactViewPose(localFrame));
          printJsonLine(sceneId, "startup pose first tick.cameraWorldPosition", {
            position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
            quaternion: camera.getWorldQuaternion(new THREE.Quaternion()).toArray(),
          });
          printJsonLine(sceneId, "startup pose first tick.meshTransform", {
            position: splatMesh?.position?.toArray?.() ?? null,
            quaternion: splatMesh?.quaternion?.toArray?.() ?? null,
            scale: splatMesh?.scale?.toArray?.() ?? null,
          });
        }
        if (mobileControlsAvailable && movementState.value) {
          applyMobileMovement(localFrame, deltaTime);
        }
        if (showControlChrome) {
          latestViewRef.current = getViewPose(localFrame);
          latestExactViewRef.current = getExactViewPose(localFrame);
          if (now - lastHudUpdate > 150) {
            lastHudUpdate = now;
            setCurrentView(latestViewRef.current);
            syncShareConfig();
          }
        }
        if (guiState) {
          guiState.activeSplats = spark.display.numSplats;
          guiState.lodSplatScale = spark.lodSplatScale;
        }
        renderer.render(scene, camera);
      }
      renderSnapshotRef.current = () => {
        renderFrame(performance.now());
        const gl = renderer.getContext();
        if (typeof gl.finish === "function") {
          gl.finish();
        }
      };
      renderer.setAnimationLoop(renderFrame);

      cleanup.fn = () => {
        debugLog(sceneId, "cleanup");
        renderer.setAnimationLoop(null);
        ro.disconnect();
        window.removeEventListener("resize", resize);
        setMobileControlsEnabled(false);
        if (mobileControlsAvailable) {
          disposeMobileControls();
        }
        if (splatMesh) {
          scene.remove(splatMesh);
          safeDispose(sceneId, "splatMesh", splatMesh);
        }
        localFrame.remove(camera);
        scene.remove(localFrame);
        scene.remove(spark);
        safeDispose(sceneId, "spark", spark);
        renderSnapshotRef.current = null;
        renderCanvasRef.current = null;
        latestExactViewRef.current = null;
        resetPoseRef.current = null;
        resetViewRef.current = () => {};
        shareConfigRef.current = null;
        xrRef.current = null;
        xrTurnAxisRef.current.copy(XR_WORLD_Y_AXIS);
        stopAudioRef.current();
        playAudioRef.current = async () => false;
        stopAudioRef.current = () => {};
        if (backgroundAudio) {
          backgroundAudio.pause();
          backgroundAudio.src = "";
          backgroundAudio = null;
        }
        for (const item of positionalAudioNodes) {
          if (item.audio.isPlaying) {
            item.audio.stop();
          }
          item.holder.remove(item.audio);
          scene.remove(item.holder);
        }
        if (audioListener) {
          camera.remove(audioListener);
        }
        if (xr.session) {
          xr.session.end().catch(() => {});
        }
        if (xrElement.parentNode === el) {
          el.removeChild(xrElement);
        }
        gui?.destroy();
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
      latestExactViewRef.current = null;
      resetPoseRef.current = null;
      resetViewRef.current = () => {};
      shareConfigRef.current = null;
      playAudioRef.current = async () => false;
      stopAudioRef.current = () => {};
      cleanup.fn?.();
    };
  }, [
    sceneId,
    splatUrl,
    needsSignedUrl,
    presignView,
    resolveSceneAudio,
    filename,
    defaultView,
    viewerMode,
    isOwnerMode,
    showControlChrome,
    hasSceneAudio,
    viewerOptions,
    savedDefaultPose,
    location.pathname,
  ]);

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

  async function handleShareLink() {
    const pose = latestExactViewRef.current ?? resetPoseRef.current ?? savedDefaultPose ?? viewerOptions.startPose;
    if (!pose) {
      setShareLabel("No view yet");
      window.setTimeout(() => setShareLabel("Share link"), 1200);
      return;
    }

    const shareConfig = shareConfigRef.current;
    const params = new URLSearchParams();
    params.set("mode", "view");
    params.set("startPos", formatNumberArray(pose.position));
    params.set("startQuat", formatNumberArray(pose.quaternion, 6));

    if (shareConfig) {
      const { options } = shareConfig;
      if (options.backgroundColor !== DEFAULT_BACKGROUND) {
        params.set("backgroundColor", options.backgroundColor.toString(16).padStart(6, "0"));
      }
      params.set("moveSpeed", Number(options.moveSpeed).toString());
      if (options.reverseLook) {
        params.set("reverseLook", "true");
      }
      if (options.reverseSlide) {
        params.set("reverseSlide", "true");
      }
      if (options.useJoystick) {
        params.set("useJoystick", "true");
      }
      if (!options.usePressMove) {
        params.set("usePressMove", "false");
      }
      if (!options.highDpi) {
        params.set("highDpi", "false");
      }
      params.set("coneFov0", String(Number(options.coneFov0)));
      params.set("coneFov", String(Number(options.coneFov)));
      params.set("coneFoveate", String(Number(options.coneFoveate)));
      params.set("behindFoveate", String(Number(options.behindFoveate)));
      params.set("lodSplatScale", String(Number(options.lodSplatScale)));
      if (options.scale && Math.abs(options.scale - 1) > 0.0001) {
        params.set("scale", String(Number(options.scale)));
      }
      if (Array.isArray(options.orient) && options.orient.length >= 4) {
        params.set("orient", formatNumberArray(options.orient.slice(0, 4), 6));
      }
    }

    const shareUrl = `${window.location.origin}${location.pathname}?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareLabel("Copied link");
      setShareToast("Share link copied");
    } catch {
      setShareLabel("Copy failed");
      setShareToast("Failed to copy link");
    }
    window.setTimeout(() => {
      setShareLabel("Share link");
      setShareToast("");
    }, 1400);
  }

  async function handleCaptureThumbnail() {
    if (!isOwnerMode || thumbnailBusy) {
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

  async function handleSaveCurrentView() {
    if (!isOwnerMode || saveViewBusy) {
      return;
    }
    const payload = latestExactViewRef.current;
    if (!payload) {
      setSaveViewLabel("No view yet");
      window.setTimeout(() => setSaveViewLabel("Set current view"), 1400);
      return;
    }

    setSaveViewBusy(true);
    setSaveViewLabel("Saving...");
    try {
      await updateSceneDefaultView({
        sceneId,
        defaultView: {
          position: payload.position,
          target: payload.target,
          quaternion: payload.quaternion,
        },
      });
      resetPoseRef.current = payload;
      setSaveViewLabel("Saved view");
    } catch (error) {
      console.error(`[SplatViewer:${sceneId}] failed to save current view`, error);
      setSaveViewLabel("Save failed");
    } finally {
      setSaveViewBusy(false);
      window.setTimeout(() => setSaveViewLabel("Set current view"), 1600);
    }
  }

  function handleResetView() {
    resetViewRef.current();
  }

  async function handleToggleAudio() {
    if (!allowAudioToggle) {
      return;
    }
    if (audioEnabled) {
      stopAudioRef.current();
      setAudioEnabled(false);
      setShareToast("Sound off");
      window.setTimeout(() => setShareToast(""), 1200);
      return;
    }
    try {
      const started = await playAudioRef.current();
      if (!started) {
        setShareToast("Audio unavailable");
        window.setTimeout(() => setShareToast(""), 1400);
        return;
      }
      setAudioEnabled(true);
      setShareToast("Sound on");
    } catch (error) {
      console.error(`[SplatViewer:${sceneId}] failed to start audio`, error);
      setShareToast("Audio blocked");
    }
    window.setTimeout(() => setShareToast(""), 1400);
  }

  async function handleToggleXr() {
    const xr = xrRef.current;
    if (!xr || (!xrSupported && !xrPresenting)) {
      setShareToast("VR unavailable");
      window.setTimeout(() => setShareToast(""), 1400);
      return;
    }
    try {
      await xr.toggleXr();
    } catch (error) {
      console.error(`[SplatViewer:${sceneId}] failed to toggle XR`, error);
      setShareToast("VR failed");
      window.setTimeout(() => setShareToast(""), 1400);
    }
  }

  return (
    <>
      {showLeftControls ? (
        <>
          <div className="viewer-controls">
            {showHomeButton ? (
              <button
                type="button"
                className="viewer-button"
                aria-label="Back to dashboard"
                data-tooltip="Back to dashboard"
                title="Back to dashboard"
                onClick={() => {
                  setShowHelpOverlay(false);
                  setShowToolsOverlay(false);
                  navigate("/");
                }}
              >
                <House className="viewer-button-icon" aria-hidden="true" />
              </button>
            ) : null}
            {showHelpButton ? (
              <button
                type="button"
                className="viewer-button"
                aria-label="Show controls help"
                data-tooltip="Help"
                title="Help"
                onClick={() => {
                  setShowToolsOverlay(false);
                  setShowHelpOverlay(true);
                }}
              >
                <CircleHelp className="viewer-button-icon" aria-hidden="true" />
              </button>
            ) : null}
            {showResetButton ? (
              <button
                type="button"
                className="viewer-button"
                aria-label="Reset viewpoint"
                data-tooltip="Reset viewpoint"
                title="Reset viewpoint"
                onClick={handleResetView}
              >
                <Crosshair className="viewer-button-icon" aria-hidden="true" />
              </button>
            ) : null}
            {showShareButton ? (
              <button
                type="button"
                className="viewer-button"
                aria-label={shareLabel}
                data-tooltip={shareLabel}
                title={shareLabel}
                onClick={() => void handleShareLink()}
              >
                <Share2 className="viewer-button-icon" aria-hidden="true" />
              </button>
            ) : null}
            {allowAudioToggle ? (
              <button
                type="button"
                className="viewer-button"
                aria-label={audioEnabled ? "Mute sound" : "Enable sound"}
                data-tooltip={audioEnabled ? "Mute sound" : "Enable sound"}
                title={audioEnabled ? "Mute sound" : "Enable sound"}
                onClick={() => void handleToggleAudio()}
              >
                {audioEnabled ? (
                  <Volume2 className="viewer-button-icon" aria-hidden="true" />
                ) : (
                  <VolumeX className="viewer-button-icon" aria-hidden="true" />
                )}
              </button>
            ) : null}
            {showXrButton ? (
              <button
                type="button"
                className="viewer-button"
                aria-label={xrPresenting ? "Exit VR" : "Enter VR"}
                data-tooltip={xrPresenting ? "Exit VR" : "Enter VR"}
                title={xrPresenting ? "Exit VR" : "Enter VR"}
                onClick={() => void handleToggleXr()}
              >
                <span className="viewer-button-badge" aria-hidden="true">
                  VR
                </span>
              </button>
            ) : null}
            {showOwnerTools ? (
              <button
                type="button"
                className="viewer-button"
                aria-label="Open owner tools"
                data-tooltip="Owner tools"
                title="Owner tools"
                onClick={() => {
                  setShowHelpOverlay(false);
                  setShowToolsOverlay(true);
                }}
              >
                <Ellipsis className="viewer-button-icon" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {shareToast ? <div className="viewer-toast">{shareToast}</div> : null}
      {showControlChrome && displayLabel ? <div className="viewer-label">{displayLabel}</div> : null}
      {showHelpOverlay ? (
        <div
          className="viewer-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowHelpOverlay(false);
            }
          }}
        >
          <div className="viewer-overlay-card">
            <div className="viewer-overlay-controls-header">
              <h3>Controls</h3>
              <div className="viewer-overlay-mode-toggle" role="tablist" aria-label="Controls">
                <button
                  type="button"
                  className={!mobileHelpMode ? "is-active" : ""}
                  onClick={() => setMobileHelpMode(false)}
                >
                  Desktop
                </button>
                <button
                  type="button"
                  className={mobileHelpMode ? "is-active" : ""}
                  onClick={() => setMobileHelpMode(true)}
                >
                  Mobile
                </button>
              </div>
            </div>
            <div className="viewer-overlay-controls-table">
              {(mobileHelpMode ? HELP_MOBILE_CONTROLS : HELP_DESKTOP_CONTROLS).map(
                ([action, effect, emphasized]) => (
                  <div className="viewer-overlay-controls-row" key={`${action}-${effect}`}>
                    <div
                      className={`viewer-overlay-controls-action${
                        emphasized ? " emphasized" : ""
                      }`}
                    >
                      {action}
                    </div>
                    <div
                      className={`viewer-overlay-controls-effect${
                        emphasized ? " emphasized" : ""
                      }`}
                    >
                      {effect}
                    </div>
                  </div>
                ),
              )}
            </div>
            <button
              type="button"
              className="viewer-overlay-close"
              onClick={() => setShowHelpOverlay(false)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
      {showOwnerTools && showToolsOverlay ? (
        <div
          className="viewer-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowToolsOverlay(false);
            }
          }}
        >
          <div className="viewer-overlay-card viewer-overlay-card--tools">
            <div className="viewer-overlay-controls-header">
              <h3>Owner tools</h3>
            </div>
            <div className="viewer-tools-actions">
              <button type="button" className="viewer-tools-button" onClick={() => void handleCopyView()}>
                {copyLabel}
              </button>
              <button
                type="button"
                className="viewer-tools-button"
                onClick={() => void handleSaveCurrentView()}
                disabled={saveViewBusy}
              >
                {saveViewLabel}
              </button>
              <button
                type="button"
                className="viewer-tools-button"
                onClick={() => void handleCaptureThumbnail()}
                disabled={thumbnailBusy}
              >
                {thumbnailLabel}
              </button>
            </div>
            <pre className="viewer-tools-pose">
{currentView
  ? JSON.stringify(currentView, null, 2)
  : "Waiting for camera pose..."}
            </pre>
            <button
              type="button"
              className="viewer-overlay-close"
              onClick={() => setShowToolsOverlay(false)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
      {err ? (
        <div className="viewer-error">
          {err}
        </div>
      ) : null}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
    </>
  );
}
