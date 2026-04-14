const CONFIG = {
  joystickSize: 120,
  knobSize: 50,
  deadzone: 0.15,
  marginX: 30,
  marginBottom: 30,
  outerColor: "rgba(255, 255, 255, 0.2)",
  outerBorder: "rgba(255, 255, 255, 0.4)",
  knobColor: "rgba(255, 255, 255, 0.5)",
  knobActiveColor: "rgba(100, 150, 255, 0.7)",
};

let initialized = false;
let enabled = true;

const sticks = {
  left: { container: null, knob: null, touch: null, center: { x: 0, y: 0 }, input: { x: 0, y: 0, active: false } },
  right: { container: null, knob: null, touch: null, center: { x: 0, y: 0 }, input: { x: 0, y: 0, active: false } },
};

let resizeHandler = null;
let orientationHandler = null;
let touchMoveHandler = null;
let touchEndHandler = null;

export function isMobileDevice() {
  if (typeof window === "undefined") {
    return false;
  }
  if (/OculusBrowser|Quest|Oculus/i.test(navigator.userAgent)) {
    return false;
  }
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    )
  );
}

export function initMobileControls(options = {}) {
  if (typeof document === "undefined") {
    return;
  }
  if (initialized) {
    setMobileControlsEnabled(true);
    return;
  }
  Object.assign(CONFIG, options);
  createStickUI("left");
  createStickUI("right");
  attachEventListeners();
  initialized = true;
}

export function getMobileInput() {
  if (!enabled || !initialized) {
    return { x: 0, y: 0, active: false };
  }
  return { ...sticks.left.input };
}

export function getMobileInputRight() {
  if (!enabled || !initialized) {
    return { x: 0, y: 0, active: false };
  }
  return { ...sticks.right.input };
}

export function setMobileControlsEnabled(value) {
  enabled = value;
  for (const stick of Object.values(sticks)) {
    if (stick.container) {
      stick.container.style.display = enabled ? "block" : "none";
    }
    if (!enabled) {
      stick.input = { x: 0, y: 0, active: false };
    }
  }
}

export function disposeMobileControls() {
  if (!initialized) {
    return;
  }
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
  }
  if (orientationHandler) {
    window.removeEventListener("orientationchange", orientationHandler);
  }
  if (touchMoveHandler) {
    document.removeEventListener("touchmove", touchMoveHandler);
  }
  if (touchEndHandler) {
    document.removeEventListener("touchend", touchEndHandler);
    document.removeEventListener("touchcancel", touchEndHandler);
  }
  for (const stick of Object.values(sticks)) {
    stick.container?.remove();
    stick.container = null;
    stick.knob = null;
    stick.touch = null;
    stick.input = { x: 0, y: 0, active: false };
  }
  initialized = false;
  resizeHandler = null;
  orientationHandler = null;
  touchMoveHandler = null;
  touchEndHandler = null;
}

function createStickUI(side) {
  const stick = sticks[side];
  const container = document.createElement("div");
  container.id = `mobile-joystick-${side}`;
  const positionCSS =
    side === "left"
      ? `left: ${CONFIG.marginX}px;`
      : `right: ${CONFIG.marginX}px;`;
  container.style.cssText = `
    position: fixed;
    ${positionCSS}
    bottom: ${CONFIG.marginBottom}px;
    width: ${CONFIG.joystickSize}px;
    height: ${CONFIG.joystickSize}px;
    z-index: 1000;
    touch-action: none;
    pointer-events: auto;
  `;

  const outer = document.createElement("div");
  outer.style.cssText = `
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: ${CONFIG.outerColor};
    border: 2px solid ${CONFIG.outerBorder};
    box-sizing: border-box;
  `;

  const knob = document.createElement("div");
  knob.style.cssText = `
    position: absolute;
    width: ${CONFIG.knobSize}px;
    height: ${CONFIG.knobSize}px;
    border-radius: 50%;
    background: ${CONFIG.knobColor};
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    transition: background 0.1s;
  `;

  outer.appendChild(knob);
  container.appendChild(outer);
  document.body.appendChild(container);

  stick.container = container;
  stick.knob = knob;
  updateStickCenter(stick);

  container.addEventListener(
    "touchstart",
    (event) => handleTouchStart(event, stick),
    { passive: false },
  );
}

function updateStickCenter(stick) {
  if (!stick.container) return;
  const rect = stick.container.getBoundingClientRect();
  stick.center = {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function attachEventListeners() {
  resizeHandler = () => {
    updateStickCenter(sticks.left);
    updateStickCenter(sticks.right);
  };
  orientationHandler = () => {
    window.setTimeout(resizeHandler, 100);
  };
  touchMoveHandler = (event) => handleTouchMove(event);
  touchEndHandler = (event) => handleTouchEnd(event);

  window.addEventListener("resize", resizeHandler);
  window.addEventListener("orientationchange", orientationHandler);
  document.addEventListener("touchmove", touchMoveHandler, { passive: false });
  document.addEventListener("touchend", touchEndHandler, { passive: false });
  document.addEventListener("touchcancel", touchEndHandler, { passive: false });
}

function handleTouchStart(event, stick) {
  if (!enabled || stick.touch !== null) return;
  const touch = event.changedTouches[0];
  stick.touch = touch.identifier;
  updateStickCenter(stick);
  updateStickPosition(stick, touch.clientX, touch.clientY);
  stick.knob.style.background = CONFIG.knobActiveColor;
  stick.input.active = true;
  event.preventDefault();
}

function handleTouchMove(event) {
  if (!enabled) return;
  for (const touch of event.changedTouches) {
    for (const stick of Object.values(sticks)) {
      if (stick.touch === touch.identifier) {
        updateStickPosition(stick, touch.clientX, touch.clientY);
        event.preventDefault();
        break;
      }
    }
  }
}

function handleTouchEnd(event) {
  for (const touch of event.changedTouches) {
    for (const stick of Object.values(sticks)) {
      if (stick.touch === touch.identifier) {
        resetStick(stick);
        break;
      }
    }
  }
}

function updateStickPosition(stick, touchX, touchY) {
  const maxRadius = (CONFIG.joystickSize - CONFIG.knobSize) / 2;

  let dx = touchX - stick.center.x;
  let dy = touchY - stick.center.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance > maxRadius) {
    dx = (dx / distance) * maxRadius;
    dy = (dy / distance) * maxRadius;
  }

  if (stick === sticks.right) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      dy = 0;
    } else {
      dx = 0;
    }
  }

  const knobX = 50 + (dx / maxRadius) * 50;
  const knobY = 50 + (dy / maxRadius) * 50;
  stick.knob.style.left = `${knobX}%`;
  stick.knob.style.top = `${knobY}%`;

  let inputX = dx / maxRadius;
  let inputY = dy / maxRadius;
  if (Math.abs(inputX) < CONFIG.deadzone) inputX = 0;
  if (Math.abs(inputY) < CONFIG.deadzone) inputY = 0;

  stick.input.x = inputX;
  stick.input.y = inputY;
}

function resetStick(stick) {
  stick.touch = null;
  stick.input = { x: 0, y: 0, active: false };
  if (stick.knob) {
    stick.knob.style.left = "50%";
    stick.knob.style.top = "50%";
    stick.knob.style.background = CONFIG.knobColor;
  }
}
