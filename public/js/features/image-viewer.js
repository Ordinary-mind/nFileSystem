const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function constrainImageTransform(state, imageSize, viewportSize) {
  const scale = clamp(Number(state.scale) || MIN_SCALE, MIN_SCALE, MAX_SCALE);
  const maxX = Math.max(0, ((Number(imageSize.width) || 0) * scale - (Number(viewportSize.width) || 0)) / 2);
  const maxY = Math.max(0, ((Number(imageSize.height) || 0) * scale - (Number(viewportSize.height) || 0)) / 2);
  return {
    scale,
    x: clamp(Number(state.x) || 0, -maxX, maxX),
    y: clamp(Number(state.y) || 0, -maxY, maxY),
  };
}

export function zoomImageAt(state, nextScale, focus, imageSize, viewportSize) {
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  const ratio = scale / state.scale;
  return constrainImageTransform({
    scale,
    x: focus.x - (focus.x - state.x) * ratio,
    y: focus.y - (focus.y - state.y) * ratio,
  }, imageSize, viewportSize);
}

function getDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getMidpoint(first, second) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export function mountImageViewer(root, source, alt = '') {
  root.innerHTML = `
    <div class="image-preview-canvas" data-image-canvas tabindex="0" aria-label="图片预览，可缩放和平移">
      <img alt="" draggable="false" data-preview-image>
      <div class="image-preview-controls" role="toolbar" aria-label="图片缩放控制">
        <button type="button" data-zoom-out aria-label="缩小图片">−</button>
        <span data-zoom-value aria-live="polite">100%</span>
        <button type="button" data-zoom-in aria-label="放大图片">＋</button>
        <button type="button" data-zoom-reset>复位</button>
      </div>
    </div>`;

  const canvas = root.querySelector('[data-image-canvas]');
  const image = root.querySelector('[data-preview-image]');
  const zoomOut = root.querySelector('[data-zoom-out]');
  const zoomIn = root.querySelector('[data-zoom-in]');
  const zoomReset = root.querySelector('[data-zoom-reset]');
  const zoomValue = root.querySelector('[data-zoom-value]');
  const pointers = new Map();
  let state = { scale: MIN_SCALE, x: 0, y: 0 };
  let gesture = null;

  const getSizes = () => ({
    imageSize: { width: image.clientWidth, height: image.clientHeight },
    viewportSize: { width: canvas.clientWidth, height: canvas.clientHeight },
  });
  const render = () => {
    image.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`;
    zoomValue.textContent = `${Math.round(state.scale * 100)}%`;
    zoomOut.disabled = state.scale <= MIN_SCALE;
    zoomIn.disabled = state.scale >= MAX_SCALE;
    zoomReset.disabled = state.scale <= MIN_SCALE && state.x === 0 && state.y === 0;
    canvas.classList.toggle('is-zoomed', state.scale > MIN_SCALE);
  };
  const constrain = () => {
    const sizes = getSizes();
    state = constrainImageTransform(state, sizes.imageSize, sizes.viewportSize);
    render();
  };
  const zoomAt = (nextScale, clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const sizes = getSizes();
    const focus = { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    state = zoomImageAt(state, nextScale, focus, sizes.imageSize, sizes.viewportSize);
    render();
  };
  const zoomCentered = (factor) => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(state.scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  const reset = () => {
    state = { scale: MIN_SCALE, x: 0, y: 0 };
    render();
  };
  const beginGesture = () => {
    const active = Array.from(pointers.values());
    if (active.length >= 2) {
      const clientMidpoint = getMidpoint(active[0], active[1]);
      const rect = canvas.getBoundingClientRect();
      const midpoint = {
        x: clientMidpoint.x - rect.left - rect.width / 2,
        y: clientMidpoint.y - rect.top - rect.height / 2,
      };
      gesture = {
        type: 'pinch',
        distance: Math.max(1, getDistance(active[0], active[1])),
        midpoint,
        state: { ...state },
      };
    } else if (active.length === 1) {
      gesture = { type: 'pan', pointer: { ...active[0] }, state: { ...state } };
    } else {
      gesture = null;
    }
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.image-preview-controls')) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = Array.from(pointers.values());
    const sizes = getSizes();
    if (active.length >= 2 && gesture?.type === 'pinch') {
      const clientMidpoint = getMidpoint(active[0], active[1]);
      const rect = canvas.getBoundingClientRect();
      const midpoint = {
        x: clientMidpoint.x - rect.left - rect.width / 2,
        y: clientMidpoint.y - rect.top - rect.height / 2,
      };
      const nextScale = clamp(gesture.state.scale * getDistance(active[0], active[1]) / gesture.distance, MIN_SCALE, MAX_SCALE);
      const ratio = nextScale / gesture.state.scale;
      state = constrainImageTransform({
        scale: nextScale,
        x: midpoint.x - (gesture.midpoint.x - gesture.state.x) * ratio,
        y: midpoint.y - (gesture.midpoint.y - gesture.state.y) * ratio,
      }, sizes.imageSize, sizes.viewportSize);
      render();
    } else if (active.length === 1 && gesture?.type === 'pan' && state.scale > MIN_SCALE) {
      state = constrainImageTransform({
        scale: gesture.state.scale,
        x: gesture.state.x + active[0].x - gesture.pointer.x,
        y: gesture.state.y + active[0].y - gesture.pointer.y,
      }, sizes.imageSize, sizes.viewportSize);
      render();
    }
  });
  const finishPointer = (event) => {
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    beginGesture();
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAt(state.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
  }, { passive: false });
  canvas.addEventListener('dblclick', (event) => {
    if (event.target.closest('.image-preview-controls')) return;
    event.preventDefault();
    if (state.scale > MIN_SCALE) reset();
    else zoomAt(2, event.clientX, event.clientY);
  });
  canvas.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') zoomCentered(1.25);
    else if (event.key === '-') zoomCentered(0.8);
    else if (event.key === '0') reset();
    else if (state.scale > MIN_SCALE && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const offsets = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
      const [x, y] = offsets[event.key];
      state = { ...state, x: state.x + x, y: state.y + y };
      constrain();
    } else return;
    event.preventDefault();
  });
  zoomOut.addEventListener('click', () => zoomCentered(0.8));
  zoomIn.addEventListener('click', () => zoomCentered(1.25));
  zoomReset.addEventListener('click', reset);
  image.addEventListener('load', constrain, { once: true });
  image.alt = alt;
  image.src = source;

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(constrain) : null;
  if (resizeObserver) resizeObserver.observe(canvas);
  render();
  return () => resizeObserver?.disconnect();
}
