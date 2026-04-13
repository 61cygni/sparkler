import { useEffect, useMemo, useRef, useState } from "react";
import GUI from "lil-gui";
import { useLocation } from "react-router-dom";
import { useAction, useMutation } from "convex/react";
import * as THREE from "three";
import { dyno, SparkControls, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
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
const DEFAULT_BACKGROUND = 0x000000;
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

function makeLodConeGuide() {
  const group = new THREE.Group();
  const circlePoints = [];
  const segments = 32;
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    circlePoints.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), -1));
  }
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(circlePoints),
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
    }),
  );
  group.add(ring);

  const spokes = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, -1),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-1, 0, -1),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, -1),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -1, -1),
  ];
  group.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(spokes),
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.35,
      }),
    ),
  );

  return group;
}

function parseViewerOptions(search, minimal) {
  const params = new URLSearchParams(search);
  const startPos = parseCsvNumbers(params.get("startPos"), 3);
  const startQuat = parseCsvNumbers(params.get("startQuat"), 4);
  const orient = parseCsvNumbers(params.get("orient"), 4);
  const scale = Number(params.get("scale") ?? 1);
  const lodSplatScale = Number(params.get("lodSplatScale") ?? "");
  const splatLimit = Number(params.get("splatLimit") ?? "");
  const moveSpeed = Number(params.get("moveSpeed") ?? BASE_MOVE_SPEED);
  const fetchPause = Number(params.get("fetchPause") ?? 0);
  const coneFov0 = Number(params.get("coneFov0") ?? 70);
  const coneFov = Number(params.get("coneFov") ?? 120);
  const coneFoveate = Number(params.get("coneFoveate") ?? 0.4);
  const behindFoveate = Number(params.get("behindFoveate") ?? 0.2);
  const showPageParam = params.get("showPage");
  const showPageValue = showPageParam === null ? -1 : Number(showPageParam);

  return {
    backgroundColor: parseHexColor(params.get("backgroundColor")),
    debug: parseBooleanParam(params.get("debug"), false),
    enableLodFetching: parseBooleanParam(params.get("enableLodFetching"), true),
    fetchPause: Number.isFinite(fetchPause) && fetchPause >= 0 ? fetchPause : 0,
    highDpi: parseBooleanParam(params.get("highDpi"), true),
    orient,
    moveSpeed: Number.isFinite(moveSpeed) && moveSpeed > 0 ? moveSpeed : BASE_MOVE_SPEED,
    pageColoring: parseBooleanParam(params.get("pageColoring"), false),
    reverseLook: parseBooleanParam(params.get("reverseLook"), isMobileDevice()),
    reverseSlide: parseBooleanParam(params.get("reverseSlide"), isMobileDevice()),
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    showPaging: parseBooleanParam(params.get("showPaging"), false),
    lodSplatScale: Number.isFinite(lodSplatScale) && lodSplatScale > 0 ? lodSplatScale : null,
    coneFov0: Number.isFinite(coneFov0) ? coneFov0 : 70,
    coneFov: Number.isFinite(coneFov) ? coneFov : 120,
    coneFoveate: Number.isFinite(coneFoveate) ? coneFoveate : 0.4,
    behindFoveate: Number.isFinite(behindFoveate) ? behindFoveate : 0.2,
    showPage: Number.isFinite(showPageValue) ? showPageValue : -1,
    showHelp: minimal ? false : parseBooleanParam(params.get("showHelp"), true),
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
 * @param {{ sceneId: string; splatUrl: string | null; needsSignedUrl: boolean; filename?: string; title?: string; minimal?: boolean; canEdit?: boolean; defaultView?: { position: number[]; target: number[]; quaternion?: number[] } | null }} props
 */
export default function SplatViewer({
  sceneId,
  splatUrl,
  needsSignedUrl,
  filename,
  title,
  minimal = false,
  canEdit = false,
  defaultView = null,
}) {
  const location = useLocation();
  const viewerOptions = useMemo(
    () => parseViewerOptions(location.search, minimal),
    [location.search, minimal],
  );
  const savedDefaultPose = useMemo(() => defaultViewToPose(defaultView), [defaultView]);
  const displayLabel = filename || title || "";
  const isRadScene = inferSplatFileType(filename, splatUrl) === "rad";
  const containerRef = useRef(null);
  const latestViewRef = useRef(null);
  const latestExactViewRef = useRef(null);
  const startupPoseLoggedRef = useRef(false);
  const resetPoseRef = useRef(null);
  const resetViewRef = useRef(() => {});
  const shareConfigRef = useRef(null);
  const renderCanvasRef = useRef(null);
  const renderSnapshotRef = useRef(null);
  const presignView = useAction(api.tigris.presignView);
  const presignThumbnailUpload = useAction(api.tigris.presignThumbnailUpload);
  const saveSceneThumbnail = useMutation(api.scenes.saveSceneThumbnail);
  const [err, setErr] = useState("");
  const [showHelpOverlay, setShowHelpOverlay] = useState(viewerOptions.showHelp);
  const [showToolsOverlay, setShowToolsOverlay] = useState(false);
  const [mobileHelpMode, setMobileHelpMode] = useState(isMobileDevice());
  const [copyLabel, setCopyLabel] = useState("Copy view");
  const [shareLabel, setShareLabel] = useState("Share link");
  const [thumbnailLabel, setThumbnailLabel] = useState("Capture thumbnail");
  const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const [currentView, setCurrentView] = useState(null);

  useEffect(() => {
    setShowHelpOverlay(viewerOptions.showHelp);
    setShowToolsOverlay(false);
    setMobileHelpMode(isMobileDevice());
    setShareLabel("Share link");
    startupPoseLoggedRef.current = false;
  }, [sceneId, viewerOptions.showHelp]);

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
      spark.enableLodFetching = viewerOptions.enableLodFetching;
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
      const showLodCameraState = { value: false };
      const freezeLodState = { value: false };
      const pagingState = {
        pagesFilled: "0 (0%)",
        showPaging: viewerOptions.showPaging,
        fetchPause: viewerOptions.fetchPause,
        pageColoring: viewerOptions.pageColoring,
        showPage: viewerOptions.showPage,
      };
      let maxPages = 0;
      let pageTimes = null;
      let dynoTime = null;
      let pageColoring = null;
      let showPage = null;
      const mobileControlsAvailable = mobileDevice && !minimal;
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

      let gui = null;
      let guiState = null;

      const lodCamera = new THREE.Group();
      scene.add(lodCamera);
      const cone0 = makeLodConeGuide();
      const cone = makeLodConeGuide();
      cone0.visible = false;
      cone.visible = false;
      lodCamera.add(cone0);
      lodCamera.add(cone);

      function updateMoveSpeed() {
        controls.fpsMovement.moveSpeed = moveSpeedState.value;
        controls.pointerControls.slideSpeed = 0.006 * moveSpeedState.value;
        controls.pointerControls.scrollSpeed = 0.0015 * moveSpeedState.value;
        const pressMoveSpeed = pressMoveState.value ? moveSpeedState.value : 0;
        controls.pointerControls.pressMoveDelayMs = 400;
        controls.pointerControls.pressMoveSpeed = pressMoveSpeed;
        controls.pointerControls.doublePressMoveSpeed = pressMoveSpeed * 3;
        controls.pointerControls.triplePressMoveSpeed = pressMoveSpeed * 10;
      }

      function updateLodCones() {
        const tan0 = Math.tan((spark.coneFov0 * Math.PI) / 360);
        const tan = Math.tan((spark.coneFov * Math.PI) / 360);
        cone0.scale.set(tan0, tan0, 1);
        cone.scale.set(tan, tan, 1);
        cone0.visible = showLodCameraState.value;
        cone.visible = showLodCameraState.value;
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
            enableLodFetching: spark.enableLodFetching,
            fetchPause: pagingState.fetchPause,
            pageColoring: pagingState.pageColoring,
            showPage: pagingState.showPage,
            showPaging: pagingState.showPaging,
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

      function printCoreSettings(label, extra = undefined) {
        printLog(sceneId, label, {
          viewerOptions,
          controls: {
            fpsMoveSpeed: controls.fpsMovement.moveSpeed,
            shiftMultiplier: controls.fpsMovement.shiftMultiplier,
            pressMoveDelayMs: controls.pointerControls.pressMoveDelayMs,
            pressMoveSpeed: controls.pointerControls.pressMoveSpeed,
            doublePressMoveSpeed: controls.pointerControls.doublePressMoveSpeed,
            triplePressMoveSpeed: controls.pointerControls.triplePressMoveSpeed,
            slideSpeed: controls.pointerControls.slideSpeed,
            scrollSpeed: controls.pointerControls.scrollSpeed,
            reverseRotate: controls.pointerControls.reverseRotate,
            reverseScroll: controls.pointerControls.reverseScroll,
            reverseSlide: controls.pointerControls.reverseSlide,
            reverseSwipe: controls.pointerControls.reverseSwipe,
          },
          spark: {
            maxStdDev,
            maxPagedSplats: spark.maxPagedSplats,
            lodSplatScale: spark.lodSplatScale,
            lodInflate: spark.lodInflate,
            coneFov0: spark.coneFov0,
            coneFov: spark.coneFov,
            coneFoveate: spark.coneFoveate,
            behindFoveate: spark.behindFoveate,
            enableLodFetching: spark.enableLodFetching,
            blurAmount: spark.blurAmount,
            preBlurAmount: spark.preBlurAmount,
          },
          movementState,
          pagingState,
          ...extra,
        });
      }

      updateMoveSpeed();
      updateLodCones();
      printCoreSettings("initial viewer control settings");
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
        let maxLayers = 256;
        try {
          const gl = renderer.getContext();
          const result = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
          if (result && typeof result === "number" && !Number.isNaN(result)) {
            maxLayers = result;
          }
        } catch {
          // Keep fallback layer count.
        }
        maxPages = Math.min(maxLayers, mobileDevice ? 96 : 1024);
        pageTimes = new dyno.DynoUniform({
          type: "vec4",
          count: Math.ceil(maxPages / 4),
          value: new Float32Array(Math.ceil(maxPages / 4) * 4),
        });
        dynoTime = dyno.dynoFloat(0);
        pageColoring = dyno.dynoBool(pagingState.pageColoring);
        showPage = dyno.dynoInt(pagingState.showPage);
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
        if (paged) {
          const applyPageTimes = (page, rgb, center) =>
            new dyno.Dyno({
              inTypes: { page: "int", pageTimes: "vec4", dynoTime: "float", rgb: "vec3", center: "vec3" },
              outTypes: { rgb: "vec3" },
              inputs: { page, pageTimes, dynoTime, rgb, center },
              statements: ({ inputs, outputs }) => dyno.unindentLines(`
                ${outputs.rgb} = ${inputs.rgb};
                int arrayIndex = ${inputs.page} >> 2;
                int element = ${inputs.page} & 3;
                float pageTime = ${inputs.pageTimes}[arrayIndex][element];
                if (pageTime > 0.0) {
                  float delta = ${inputs.dynoTime} - pageTime;
                  if (delta > 0.0) {
                    float flash = exp(-max(delta, 0.0) * 4.0);
                    ${outputs.rgb} = mix(${outputs.rgb}, vec3(0.5, 1.0, 0.5), flash);
                  }
                }
              `),
            });

          splatMesh.worldModifier = dyno.dynoBlock(
            { gsplat: dyno.Gsplat },
            { gsplat: dyno.Gsplat },
            ({ gsplat }) => {
              const { index, opacity, rgb, center } = dyno.splitGsplat(gsplat).outputs;
              const page = dyno.shr(index, dyno.dynoConst("int", 16));
              const showPageDisabled = dyno.lessThan(showPage, dyno.dynoConst("int", 0));
              const pageEqual = dyno.equal(page, showPage);
              const newOpacity = dyno.select(
                dyno.or(showPageDisabled, pageEqual),
                opacity,
                dyno.dynoConst("float", 0),
              );
              const debugColor = dyno.mul(rgb, dyno.debugColorHue(page));
              let newRgb = dyno.select(pageColoring, debugColor, rgb);
              newRgb = applyPageTimes(page, newRgb, center).outputs.rgb;
              return {
                gsplat: dyno.combineGsplat({
                  gsplat,
                  opacity: newOpacity,
                  rgb: newRgb,
                }),
              };
            },
          );
          splatMesh.updateGenerator();
        }
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
        if (!minimal) {
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
              printCoreSettings("GUI changed: Use mobile joystick", { changedValue: value });
            });
          movementFolder
            .add(pressMoveState, "value")
            .name("Press+hold to move")
            .onChange((value) => {
              updateMoveSpeed();
              printCoreSettings("GUI changed: Press+hold to move", { changedValue: value });
            });
          movementFolder
            .add(moveSpeedState, "value", 0.1, 5.0, 0.1)
            .name("Move speed")
            .onChange((value) => {
              updateMoveSpeed();
              printCoreSettings("GUI changed: Move speed", { changedValue: value });
            });
          movementFolder
            .add(reverseLookState, "value")
            .name("Reverse look")
            .onChange((value) => {
              controls.pointerControls.reverseRotate = value;
              controls.pointerControls.reverseScroll = value;
              printCoreSettings("GUI changed: Reverse look", { changedValue: value });
            });
          movementFolder
            .add(reverseSlideState, "value")
            .name("Reverse slide")
            .onChange((value) => {
              controls.pointerControls.reverseSlide = value;
              controls.pointerControls.reverseSwipe = value;
              controls.pointerControls.reverseScroll = value;
              printCoreSettings("GUI changed: Reverse slide", { changedValue: value });
            });

          const lodFolder = gui.addFolder("LoD").close();
          lodFolder.add(guiState, "activeSplats").name("# active splats").listen();
          lodFolder
            .add(spark, "lodSplatScale", 0.001, 2.0, 0.001)
            .name("LoD detail")
            .listen()
            .onChange(() => {
              spark.lodDirty = true;
              printCoreSettings("GUI changed: LoD detail");
            });
          lodFolder
            .add(showLodCameraState, "value")
            .name("Show LoD camera")
            .listen()
            .onChange((value) => {
              updateLodCones();
              printCoreSettings("GUI changed: Show LoD camera", { changedValue: value });
            });
          lodFolder
            .add(freezeLodState, "value")
            .name("Freeze LoD camera")
            .listen()
            .onChange(() => {
              spark.lodDirty = true;
              printCoreSettings("GUI changed: Freeze LoD camera", {
                changedValue: freezeLodState.value,
              });
            });
          lodFolder
            .add(spark, "coneFov0", 0, 120, 1)
            .name("Cone Fov 0")
            .listen()
            .onChange(() => {
              spark.coneFov = Math.max(spark.coneFov0, spark.coneFov);
              updateLodCones();
              spark.lodDirty = true;
              printCoreSettings("GUI changed: Cone Fov 0");
            });
          lodFolder
            .add(spark, "coneFov", 0, 120, 1)
            .name("Cone Fov")
            .listen()
            .onChange(() => {
              spark.coneFov0 = Math.min(spark.coneFov0, spark.coneFov);
              updateLodCones();
              spark.lodDirty = true;
              printCoreSettings("GUI changed: Cone Fov");
            });
          lodFolder
            .add(spark, "coneFoveate", 0.005, 1.0, 0.001)
            .name("Cone Foveate")
            .listen()
            .onChange(() => {
              spark.behindFoveate = Math.min(spark.coneFoveate, spark.behindFoveate);
              spark.lodDirty = true;
              printCoreSettings("GUI changed: Cone Foveate");
            });
          lodFolder
            .add(spark, "behindFoveate", 0.005, 1.0, 0.001)
            .name("Behind Foveate")
            .listen()
            .onChange(() => {
              spark.coneFoveate = Math.max(spark.coneFoveate, spark.behindFoveate);
              spark.lodDirty = true;
              printCoreSettings("GUI changed: Behind Foveate");
            });
          lodFolder
            .add(guiState, "highDpi")
            .name("High DPI")
            .listen()
            .onChange((value) => {
              renderer.setPixelRatio(value ? Math.min(window.devicePixelRatio, 2) : 1);
              resize();
              printCoreSettings("GUI changed: High DPI", { changedValue: value });
            });

          const pagingFolder = gui.addFolder("Page table").close();
          pagingFolder.add(pagingState, "pagesFilled").name("pages filled").listen();
          pagingFolder
            .add(pagingState, "showPaging")
            .name("Show page loading")
            .listen();
          pagingFolder
            .add(pagingState, "fetchPause", 0, 2000, 1)
            .name("Fetch interval (ms)")
            .listen();
          pagingFolder
            .add(spark, "enableLodFetching")
            .name("Enable page fetching")
            .listen()
            .onChange(() => {
              spark.lodDirty = true;
              printCoreSettings("GUI changed: Enable page fetching");
            });
          pagingFolder
            .add(pagingState, "pageColoring")
            .name("Page Coloring")
            .listen()
            .onChange((value) => {
              if (pageColoring) {
                pageColoring.value = value;
              }
              splatMesh.updateVersion();
              printCoreSettings("GUI changed: Page Coloring", { changedValue: value });
            });
          pagingFolder
            .add(pagingState, "showPage", -1, maxPages - 1, 1)
            .name("Show Page")
            .listen()
            .onChange((value) => {
              if (showPage) {
                showPage.value = value;
              }
              splatMesh.updateVersion();
              printCoreSettings("GUI changed: Show Page", { changedValue: value });
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
        if (!minimal) {
          latestViewRef.current = getViewPose(localFrame);
          latestExactViewRef.current = getExactViewPose(localFrame);
          if (now - lastHudUpdate > 150) {
            lastHudUpdate = now;
            setCurrentView(latestViewRef.current);
            syncShareConfig();
          }
        }
        const lodPos = spark.currentLod?.pos ?? localFrame.position.clone();
        const lodQuat = spark.currentLod?.quat ?? localFrame.quaternion.clone();
        lodCamera.position.copy(lodPos);
        lodCamera.quaternion.copy(lodQuat);
        if (freezeLodState.value) {
          spark.lodPosOverride = lodCamera.getWorldPosition(new THREE.Vector3());
          spark.lodQuatOverride = lodCamera.getWorldQuaternion(new THREE.Quaternion());
        } else {
          spark.lodPosOverride = undefined;
          spark.lodQuatOverride = undefined;
        }
        if (guiState) {
          if (dynoTime) {
            dynoTime.value = now / 1000;
          }
          guiState.activeSplats = spark.display.numSplats;
          guiState.lodSplatScale = spark.lodSplatScale;
          if (spark.pager?.pageToSplatsChunk && pageTimes) {
            spark.pager.fetchPause = pagingState.fetchPause;
            let loadedPages = 0;
            for (let i = 0; i < spark.pager.pageToSplatsChunk.length; i += 1) {
              const chunk = spark.pager.pageToSplatsChunk[i];
              if (chunk) {
                loadedPages += 1;
                pageTimes.value[i] = pagingState.showPaging ? chunk.time / 1000 : 0;
              } else {
                pageTimes.value[i] = 0;
              }
            }
            const totalPages = Math.max(spark.pager.pageToSplatsChunk.length, 1);
            pagingState.pagesFilled = `${loadedPages} (${((loadedPages / totalPages) * 100).toFixed(0)}%)`;
          } else {
            pagingState.pagesFilled = "0 (0%)";
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
      cleanup.fn?.();
    };
  }, [
    sceneId,
    splatUrl,
    needsSignedUrl,
    presignView,
    filename,
    minimal,
    defaultView,
    canEdit,
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
    params.set("startPos", formatNumberArray(pose.position));
    params.set("startQuat", formatNumberArray(pose.quaternion, 6));
    params.set("showHelp", "false");

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
      if (!options.enableLodFetching) {
        params.set("enableLodFetching", "false");
      }
      if (options.fetchPause > 0) {
        params.set("fetchPause", String(options.fetchPause));
      }
      if (options.pageColoring) {
        params.set("pageColoring", "true");
      }
      if (options.showPage >= 0) {
        params.set("showPage", String(options.showPage));
      }
      if (options.showPaging) {
        params.set("showPaging", "true");
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
    } catch {
      setShareLabel("Copy failed");
    }
    window.setTimeout(() => setShareLabel("Share link"), 1400);
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

  function handleResetView() {
    resetViewRef.current();
  }

  return (
    <>
      {!minimal ? (
        <>
          <div className="viewer-controls">
            <button
              type="button"
              className="viewer-button"
              title="Help"
              onClick={() => {
                setShowToolsOverlay(false);
                setShowHelpOverlay(true);
              }}
            >
              ?
            </button>
            <button
              type="button"
              className="viewer-button"
              title="Reset viewpoint"
              onClick={handleResetView}
            >
              ⌖
            </button>
            <button
              type="button"
              className="viewer-button"
              title={shareLabel}
              onClick={() => void handleShareLink()}
            >
              ↗
            </button>
            {canEdit ? (
              <button
                type="button"
                className="viewer-button"
                title="Owner tools"
                onClick={() => {
                  setShowHelpOverlay(false);
                  setShowToolsOverlay(true);
                }}
              >
                ⋯
              </button>
            ) : null}
          </div>
          {displayLabel ? <div className="viewer-label">{displayLabel}</div> : null}
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
                <p className="viewer-overlay-intro">
                  3D Gaussian splats rendered with Spark 2.0 streaming and level of detail.
                  {isRadScene ? " Green flashes in debug mode indicate streamed RAD pages." : ""}
                </p>
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
                  Start exploring
                </button>
              </div>
            </div>
          ) : null}
          {showToolsOverlay ? (
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
        </>
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
