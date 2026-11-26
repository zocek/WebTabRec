import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEnv } from '../e2e/helpers/chrome-mock.js';
import { buildMinimalPngDataUrl, findOverlayTarget } from '../e2e/helpers/fixtures.js';

async function loadSelector(env) {
  await env.requireModule('src/content/region-selector.js', 'unit-rs');
  return globalThis.__WEBTABREC_REGION_SELECTOR__;
}

test('region-selector geometry helpers: clamp, normalizeRect, loupe positioning, sample rect, and buildCropRect', async () => {
  const { env, cleanup } = createChromeEnv();
  try {
    const rs = await loadSelector(env);

    assert.equal(rs.clamp(150, 0, 100), 100);
    assert.equal(rs.clamp(-10, 0, 100), 0);
    assert.equal(rs.clamp(NaN, 5, 100), 5);

    // Reverse drag + out-of-bounds clamping
    assert.deepEqual(rs.normalizeRect(300, 250, 100, 50, 1280, 800), {
      x: 100,
      y: 50,
      width: 200,
      height: 200
    });
    assert.deepEqual(rs.normalizeRect(1400, 900, -20, -10, 1280, 800), {
      x: 0,
      y: 0,
      width: 1280,
      height: 800
    });

    // Loupe positioning & edge auto-flip
    const normal = rs.computeLoupePosition(200, 200, 1280, 800, 136, 20, 8);
    assert.deepEqual(normal, { left: 220, top: 220, flippedX: false, flippedY: false });

    const edge = rs.computeLoupePosition(1270, 790, 1280, 800, 136, 20, 8);
    assert.equal(edge.flippedX, true);
    assert.equal(edge.flippedY, true);
    assert.ok(edge.left >= 8 && edge.left + 136 <= 1280 - 8);
    assert.ok(edge.top >= 8 && edge.top + 136 <= 800 - 8);

    // 150% DPI loupe sample rect
    const sample = rs.computeLoupeSampleRect(640, 400, 1280, 800, 1920, 1200, 136, 8);
    assert.equal(sample.patchCss, 17);
    assert.equal(sample.scaleX, 1.5);
    assert.equal(sample.scaleY, 1.5);
    assert.equal(sample.sw, 25.5);
    assert.equal(sample.sh, 25.5);

    // Normalized cropRect with viewport geometry
    const crop = rs.buildCropRect({ x: 320, y: 200, width: 640, height: 400 }, 1280, 800);
    assert.deepEqual(crop, {
      xRatio: 0.25,
      yRatio: 0.25,
      wRatio: 0.5,
      hRatio: 0.5,
      cssWidth: 640,
      cssHeight: 400,
      viewportWidth: 1280,
      viewportHeight: 800,
      viewportAspect: 1280 / 800
    });
    // Prefers physical captureVisibleTab surface aspect when consistent with CSS viewport (e.g. 125%/150% DPI)
    const dpiCrop = rs.buildCropRect(
      { x: 100, y: 100, width: 600, height: 338 },
      1228,
      1000,
      { width: 1841, height: 1500 }
    );
    assert.equal(dpiCrop.viewportWidth, 1228);
    assert.equal(dpiCrop.viewportHeight, 1000);
    assert.equal(dpiCrop.surfaceWidth, 1841);
    assert.equal(dpiCrop.surfaceHeight, 1500);
    assert.ok(Math.abs(dpiCrop.viewportAspect - 1841 / 1500) < 1e-12);
    // Falls back to CSS viewport aspect if window was resized since screenshot capture
    const resizedCrop = rs.buildCropRect(
      { x: 100, y: 100, width: 400, height: 300 },
      900,
      900,
      { width: 1920, height: 1080 }
    );
    assert.equal(resizedCrop.viewportAspect, 1);
    assert.equal(resizedCrop.surfaceWidth, undefined);

    const fractionalCrop = rs.buildCropRect({ x: 320, y: 200, width: 640.4, height: 400.6 }, 1280, 800);
    assert.equal(fractionalCrop.cssWidth, 640);
    assert.equal(fractionalCrop.cssHeight, 401);
    assert.ok(Math.abs(fractionalCrop.wRatio - 640.4 / 1280) < 1e-12);
    assert.ok(Math.abs(fractionalCrop.hRatio - 400.6 / 800) < 1e-12);
  } finally {
    cleanup();
  }
});

test('region-selector DOM lifecycle: Shadow DOM mount, idempotent cleanup, min size check, resize, reselect, cancel, confirm', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    const selected = [];
    const cancelled = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_SELECTED') selected.push(m.payload);
      if (m.type === 'REGION_CANCELLED') cancelled.push(m.payload);
      return false;
    });

    const rs = await loadSelector(env);
    const config = {
      tabId: 1,
      screenshotDataUrl: buildMinimalPngDataUrl({ width: 16, height: 16 }),
      strings: {
        regionHintDrag: 'Click and drag to select area · Press Esc to cancel',
        regionBtnStart: 'Start Recording',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Selected area is too small (minimum 32 × 32 px). Drag a larger region.'
      },
      limits: { MIN_REGION_SIZE_PX: 32, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    };

    const inst1 = rs.mountRegionSelector(config);
    const activeHosts1 = env.pageDocument.documentElement.children.filter((el) =>
      env.getClosedShadowRoot(el)
    );
    assert.equal(activeHosts1.length, 1);
    assert.equal(inst1.host.shadowRoot, null);
    assert.equal(inst1.host.style.zIndex, '2147483647');
    assert.ok(inst1.shadow.querySelector('style'));

    // Re-mount replaces stale host cleanly
    const inst2 = rs.mountRegionSelector(config);
    const activeHosts2 = env.pageDocument.documentElement.children.filter((el) =>
      env.getClosedShadowRoot(el)
    );
    assert.equal(activeHosts2.length, 1);
    assert.equal(inst1.host.parentElement, null);

    const overlay = findOverlayTarget(inst2.shadow);

    // Too small (< 32x32) drag
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 50, clientY: 50, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 60, clientY: 60, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 60, clientY: 60, bubbles: true });
    assert.match(inst2.shadow.textContent, /32 × 32 px/);
    assert.equal(selected.length, 0);

    // Valid drag (>= 32x32)
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 400, clientY: 300, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 400, clientY: 300, bubbles: true });
    assert.ok(env.state.drawLog.smoothingChanges.includes(false));
    assert.equal(inst2.getRect().width, 300);
    assert.equal(inst2.getRect().height, 200);

    // Corner handle resize
    const seHandle = inst2.shadow.querySelector('[data-handle="se"]');
    seHandle.dispatchEvent({ type: 'pointerdown', clientX: 400, clientY: 300, button: 0, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointermove', clientX: 500, clientY: 400, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointerup', clientX: 500, clientY: 400, bubbles: true });
    assert.equal(inst2.getRect().width, 400);
    assert.equal(inst2.getRect().height, 300);

    // Reselect resets without unmounting
    inst2.shadow.getElementById('btnRegionReselect').click();
    assert.notEqual(inst2.host.parentElement, null);
    assert.equal(inst2.getRect(), null);

    // Re-drag and confirm via Enter key
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
    assert.equal(inst2.host.parentElement, null);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].cropRect.cssWidth, 200);
    assert.equal(selected[0].cropRect.cssHeight, 160);

    // Mount again and cancel via Escape
    const inst3 = rs.mountRegionSelector(config);
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    assert.equal(inst3.host.parentElement, null);
    assert.equal(cancelled.length, 1);
  } finally {
    cleanup();
  }
});

test('region-selector handles synchronous Image.onload without TDZ ReferenceError', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  const OriginalImage = globalThis.Image;
  try {
    globalThis.Image = class SyncImage {
      constructor() {
        this.naturalWidth = 1280;
        this.naturalHeight = 800;
        this.width = 1280;
        this.height = 800;
        this.onload = null;
        this.onerror = null;
      }
      set src(v) {
        this._src = v;
        this.onload?.({ target: this });
      }
      get src() {
        return this._src;
      }
    };

    const rs = await loadSelector(env);
    const inst = rs.mountRegionSelector({
      tabId: 1,
      screenshotDataUrl: buildMinimalPngDataUrl({ width: 16, height: 16 }),
      strings: {
        regionHintDrag: 'Drag',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small'
      },
      limits: { MIN_REGION_SIZE_PX: 32, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    });

    assert.ok(inst.host);
    assert.notEqual(inst.host.parentElement, null);
    const overlay = inst.shadow.querySelector('[data-role="overlay"]');
    assert.ok(overlay);
    // No screenshot drawn on full-page overlay; loupe draws only on pointermove
    assert.equal(env.state.drawLog.drawImages.length, 0);
    overlay.dispatchEvent({ type: 'pointermove', clientX: 200, clientY: 180, bubbles: true });
    assert.ok(env.state.drawLog.ops.length > 0);
  } finally {
    globalThis.Image = OriginalImage;
    cleanup();
  }
});

test('region-selector prevents duplicate REGION_SELECTED and REGION_CANCELLED submissions', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    const selected = [];
    const cancelled = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_SELECTED') selected.push(m.payload);
      if (m.type === 'REGION_CANCELLED') cancelled.push(m.payload);
      return false;
    });

    const rs = await loadSelector(env);
    const config = {
      tabId: 1,
      screenshotDataUrl: buildMinimalPngDataUrl({ width: 16, height: 16 }),
      strings: {
        regionHintDrag: 'Drag',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small'
      },
      limits: { MIN_REGION_SIZE_PX: 32, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    };

    const inst1 = rs.mountRegionSelector(config);
    const overlay1 = findOverlayTarget(inst1.shadow);
    overlay1.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay1.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay1.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });

    const btnStart = inst1.shadow.getElementById('btnRegionStart');
    btnStart.click();
    btnStart.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(selected.length, 1);

    const inst2 = rs.mountRegionSelector(config);
    const btnCancel = inst2.shadow.getElementById('btnRegionCancel');
    btnCancel.click();
    btnCancel.click();
    assert.equal(cancelled.length, 1);
  } finally {
    cleanup();
  }
});

test('region-selector Enter key skips confirmSelection when btnReselect or btnCancel has focus', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    const selected = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_SELECTED') selected.push(m.payload);
      return false;
    });

    const rs = await loadSelector(env);
    const inst = rs.mountRegionSelector({
      tabId: 1,
      screenshotDataUrl: buildMinimalPngDataUrl({ width: 16, height: 16 }),
      strings: {
        regionHintDrag: 'Drag',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small'
      },
      limits: { MIN_REGION_SIZE_PX: 32, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    });

    const overlay = findOverlayTarget(inst.shadow);
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });

    let prevented = false;
    inst.shadow.activeElement = inst.shadow.getElementById('btnRegionReselect');
    env.pageDocument.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      bubbles: true,
      preventDefault() {
        prevented = true;
      }
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(prevented, false);
    assert.equal(selected.length, 0);
    assert.notEqual(inst.host.parentElement, null);

    prevented = false;
    inst.shadow.activeElement = inst.shadow.getElementById('btnRegionCancel');
    env.pageDocument.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      bubbles: true,
      preventDefault() {
        prevented = true;
      }
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(prevented, false);
    assert.equal(selected.length, 0);

    prevented = false;
    inst.shadow.activeElement = inst.shadow.getElementById('btnRegionStart');
    env.pageDocument.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      bubbles: true,
      preventDefault() {
        prevented = true;
      }
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(prevented, true);
    assert.equal(selected.length, 1);
  } finally {
    cleanup();
  }
});


test('region-selector rejects untrusted events, hides closed Shadow DOM, clears config/img, and supports keyboard move/resize', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    const selected = [];
    const cancelled = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'REGION_SELECTED') selected.push(m.payload);
      if (m.type === 'REGION_CANCELLED') cancelled.push(m.payload);
      return false;
    });

    const rs = await loadSelector(env);
    globalThis.__WEBTABREC_REGION_CONFIG__ = {
      tabId: 1,
      selectionToken: 'tok-rs-1',
      screenshotDataUrl: buildMinimalPngDataUrl(),
      strings: {
        regionHintDrag: 'Drag',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small'
      },
      limits: { MIN_REGION_SIZE_PX: 32, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    };

    const inst = rs.mountRegionSelector(globalThis.__WEBTABREC_REGION_CONFIG__);
    assert.equal(inst.host.shadowRoot, null);
    assert.equal(env.getClosedShadowRoot(inst.host), inst.shadow);

    const overlay = findOverlayTarget(inst.shadow);
    // Untrusted events MUST be ignored (EXT-01)
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, isTrusted: false, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 400, clientY: 300, isTrusted: false, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 400, clientY: 300, isTrusted: false, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: false, bubbles: true });
    assert.equal(cancelled.length, 0);
    assert.equal(selected.length, 0);
    assert.notEqual(inst.host.parentElement, null);

    // Trusted drag -> selected phase
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0, bubbles: true });
    overlay.dispatchEvent({ type: 'pointermove', clientX: 300, clientY: 260, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerup', clientX: 300, clientY: 260, bubbles: true });

    // Keyboard arrow move (+1px) and Ctrl+Shift+arrow resize (+10px) in selected phase (EXT-37)
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'ArrowRight', bubbles: true, preventDefault() {} });
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'ArrowDown', ctrlKey: true, shiftKey: true, bubbles: true, preventDefault() {} });

    // Untrusted button click ignored; trusted click submits with selectionToken
    const btnStart = inst.shadow.getElementById('btnRegionStart');
    btnStart.dispatchEvent({ type: 'click', isTrusted: false, bubbles: true });
    assert.equal(selected.length, 0);

    btnStart.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].selectionToken, 'tok-rs-1');
    assert.equal(selected[0].cropRect.cssWidth, 200);
    assert.equal(selected[0].cropRect.cssHeight, 170);
    assert.equal(inst.host.parentElement, null);
    assert.equal(globalThis.__WEBTABREC_REGION_CONFIG__, undefined);
  } finally {
    cleanup();
  }
});

test('R-05 regression: early cleanup() before Image.onload clears pendingImg.src and handlers', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  const OriginalImage = globalThis.Image;
  const createdImages = [];
  try {
    globalThis.Image = class PendingImage {
      constructor() {
        this.naturalWidth = 1280;
        this.naturalHeight = 800;
        this.onload = null;
        this.onerror = null;
        this._src = '';
        createdImages.push(this);
      }
      set src(v) {
        this._src = v;
      }
      get src() {
        return this._src;
      }
    };

    const rs = await loadSelector(env);
    const inst = rs.mountRegionSelector({
      tabId: 1,
      screenshotDataUrl: buildMinimalPngDataUrl({ width: 16, height: 16 }),
      strings: {
        regionHintDrag: 'Drag',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small'
      },
      limits: { MIN_REGION_SIZE_PX: 32, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    });

    assert.equal(createdImages.length, 1);
    assert.notEqual(createdImages[0].src, '');
    assert.equal(typeof createdImages[0].onload, 'function');

    // Cancel before Image.onload fires
    inst.cleanup();
    assert.equal(createdImages[0].src, '');
    assert.equal(createdImages[0].onload, null);
    assert.equal(createdImages[0].onerror, null);
  } finally {
    globalThis.Image = OriginalImage;
    cleanup();
  }
});

test('smart region picker deduplicates wrappers, prioritizes media blocks, supports wheel/button hierarchy, first-use coachmark, and hybrid drag', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    const messages = [];
    env.chrome.runtime.onMessage.addListener((m) => {
      messages.push(m);
      return false;
    });

    const rs = await loadSelector(env);

    // 1. Pure helpers: dedupe identical wrapper div, clip to viewport, ignore tiny/hidden/full-page
    const makeFakeEl = (tagName, rect, attrs = {}) => ({
      tagName,
      id: attrs.id || '',
      getAttribute: (k) => attrs[k] ?? null,
      getBoundingClientRect: () => rect
    });
    const spanTiny = makeFakeEl('SPAN', { left: 100, top: 100, width: 12, height: 12 });
    const videoEl = makeFakeEl('VIDEO', { left: 100, top: 80, width: 640, height: 360 });
    const wrapperDiv = makeFakeEl('DIV', { left: 99, top: 80, width: 642, height: 361 }); // within 4px -> deduped
    const cardArticle = makeFakeEl('ARTICLE', { left: 60, top: 40, width: 760, height: 500 });
    const fullSection = makeFakeEl('SECTION', { left: 0, top: 0, width: 1280, height: 800 }); // 100% viewport -> filtered
    const hiddenDiv = makeFakeEl('DIV', { left: 80, top: 60, width: 700, height: 420 }, { id: 'hidden' });

    const stack = rs.buildSmartCandidateStack(
      [spanTiny, videoEl, wrapperDiv, hiddenDiv, cardArticle, fullSection],
      1280,
      800,
      {
        minSize: 32,
        dedupeTolerance: 4,
        getComputedStyleFn: (el) => (el.id === 'hidden' ? { display: 'none' } : { display: 'block', opacity: '1' })
      }
    );
    assert.equal(stack.length, 2);
    assert.equal(stack[0].labelKey, 'regionElVideo');
    assert.equal(stack[1].labelKey, 'regionElArticle');
    assert.equal(rs.pickDefaultCandidateIndex(stack), 0);

    // 2. Live mount in smart mode with first-use coachmark, wheel stepping, button widening, and hybrid drag
    videoEl.parentElement = wrapperDiv;
    wrapperDiv.parentElement = cardArticle;
    cardArticle.parentElement = null;
    env.pageDocument.elementsFromPoint = () => [videoEl, wrapperDiv, cardArticle];

    const inst = rs.mountRegionSelector({
      tabId: 1,
      selectionToken: 'tok-smart-1',
      pickerMode: 'smart',
      showFirstUseHint: true,
      screenshotDataUrl: buildMinimalPngDataUrl(),
      strings: {
        regionHintDrag: 'Drag',
        regionHintSmart: 'Smart hint',
        regionModeSmart: 'Blocks',
        regionModeManual: 'Manual',
        regionHelpToggleAria: 'Tips',
        regionCoachTitle: 'Quick tip',
        regionCoachStepHover: 'Hover',
        regionCoachStepWheel: 'Wheel',
        regionCoachStepClick: 'Click',
        regionCoachGotIt: 'Got it',
        regionBtnWider: '▲ Wider',
        regionBtnNarrower: '▼ Narrower',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small',
        regionElVideo: 'Video',
        regionElArticle: 'Article',
        regionElBlock: 'Block'
      },
      limits: { MIN_REGION_SIZE_PX: 32, REGION_DEDUPE_TOLERANCE_PX: 4, REGION_DRAG_SWITCH_PX: 6, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    });

    const coachmark = inst.shadow.getElementById('regionCoachmark');
    assert.equal(coachmark.hidden, false);
    assert.equal(inst.getPickerMode(), 'smart');

    // Hover inspects DOM under cursor -> highlights Video (640x360)
    const overlay = findOverlayTarget(inst.shadow);
    env.pageDocument.dispatchEvent({ type: 'pointermove', clientX: 200, clientY: 150, bubbles: true });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(inst.getRect()?.width, 640);
    assert.equal(inst.getRect()?.height, 360);

    // Untrusted wheel ignored
    env.pageDocument.dispatchEvent({ type: 'wheel', deltaY: -100, clientX: 200, clientY: 150, isTrusted: false, bubbles: true });
    assert.equal(inst.getRect()?.width, 640);

    // Trusted wheel UP widens to Article (760x500) and auto-dismisses first-use coachmark
    env.pageDocument.dispatchEvent({ type: 'wheel', deltaY: -100, clientX: 200, clientY: 150, bubbles: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(inst.getRect()?.width, 760);
    assert.equal(coachmark.hidden, true);
    assert.ok(messages.some((m) => m.type === 'REGION_HINT_DISMISSED' && m.payload?.selectionToken === 'tok-smart-1'));

    // Wheel DOWN narrows back to Video (640x360)
    env.pageDocument.dispatchEvent({ type: 'wheel', deltaY: 100, clientX: 200, clientY: 150, bubbles: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(inst.getRect()?.width, 640);

    // Short click locks Video and reveals Wider/Narrower hierarchy buttons for touchpad users
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 200, clientY: 150, button: 0, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointerup', clientX: 202, clientY: 151, bubbles: true });
    const btnWider = inst.shadow.getElementById('btnRegionWider');
    const btnNarrower = inst.shadow.getElementById('btnRegionNarrower');
    assert.equal(btnWider.disabled, false);
    assert.equal(btnNarrower.disabled, true);

    // Clicking Wider expands locked selection to Article (760x500)
    btnWider.click();
    assert.equal(inst.getRect()?.width, 760);
    assert.equal(btnWider.disabled, true);
    assert.equal(btnNarrower.disabled, false);

    // Reselect + hybrid drag (>6px) switches cleanly into manual drag with 8x loupe
    inst.shadow.getElementById('btnRegionReselect').click();
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 50, clientY: 50, button: 0, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointermove', clientX: 250, clientY: 200, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointerup', clientX: 250, clientY: 200, bubbles: true });
    assert.equal(inst.getRect()?.width, 200);
    assert.equal(inst.getRect()?.height, 150);

    // Reselect + M key toggles mode and notifies background
    inst.shadow.getElementById('btnRegionReselect').click();
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'm', bubbles: true, preventDefault() {} });
    assert.equal(inst.getPickerMode(), 'manual');
    assert.ok(messages.some((m) => m.type === 'REGION_PICKER_MODE_CHANGED' && m.payload?.pickerMode === 'manual'));

    // R4-U4f regression: keyboard-only Enter in manual idle mode creates a centered starter rect without mouse movement
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {} });
    const kbRect = inst.getRect();
    assert.ok(kbRect && kbRect.width >= 32 && kbRect.height >= 32, 'Enter in manual idle must create starter rect');
    const prevX = kbRect.x;
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'ArrowRight', shiftKey: true, bubbles: true, preventDefault() {} });
    assert.equal(inst.getRect().x, prevX + 10);

    inst.cleanup();
  } finally {
    cleanup();
  }
});

test('R2 regression: Smart Picker avoids occluded non-ancestors, clips overflow containers, handles fast click before rAF, closed Shadow DOM hover, resize invalidation, unified arrows, and coachmark on mode switch', async () => {
  const { env, cleanup } = createChromeEnv({ viewportWidth: 1280, viewportHeight: 800 });
  try {
    const rs = await loadSelector(env);
    const makeEl = (tagName, rect, attrs = {}) => ({
      tagName,
      id: attrs.id || '',
      parentElement: null,
      getAttribute: (k) => attrs[k] ?? null,
      getBoundingClientRect: () => rect
    });

    // 1. C2: Modal over occluded <video> must NOT include occluded <video> in hierarchy
    const modalContent = makeEl('DIV', { left: 300, top: 200, width: 400, height: 220 });
    const modalDialog = makeEl('DIALOG', { left: 280, top: 180, width: 440, height: 260 });
    const occludedVideo = makeEl('VIDEO', { left: 50, top: 50, width: 900, height: 500 });
    modalContent.parentElement = modalDialog;
    const hostMock = {
      style: {
        pointerEvents: 'auto',
        setPropertyCalls: [],
        setProperty(k, v, p) {
          this.setPropertyCalls.push([k, v, p]);
          if (k === 'pointer-events') this.pointerEvents = v;
        }
      }
    };
    const fakeDocModal = {
      elementsFromPoint: () => [modalContent, modalDialog, occludedVideo]
    };
    const modalChain = rs.collectDeepElementsAtPoint(fakeDocModal, hostMock, 350, 250, 1280, 800);
    assert.equal(modalChain.includes(occludedVideo), false);
    assert.equal(modalChain[0], modalContent);
    assert.equal(modalChain[1], modalDialog);
    // Claude L-2: pointer-events toggled with !important
    assert.deepEqual(hostMock.style.setPropertyCalls[0], ['pointer-events', 'none', 'important']);
    assert.deepEqual(hostMock.style.setPropertyCalls[1], ['pointer-events', 'auto', 'important']);

    // Same-rect transparent player overlay over <video> DOES promote <video> cleanly
    const playerOverlay = makeEl('DIV', { left: 100, top: 80, width: 640, height: 360 });
    const playerVideo = makeEl('VIDEO', { left: 100, top: 80, width: 640, height: 360 });
    const playerWrap = makeEl('SECTION', { left: 80, top: 60, width: 700, height: 420 });
    playerVideo.parentElement = playerWrap;
    const fakeDocPlayer = {
      elementsFromPoint: () => [playerOverlay, playerVideo, playerWrap]
    };
    const playerChain = rs.collectDeepElementsAtPoint(fakeDocPlayer, hostMock, 200, 200, 1280, 800);
    assert.equal(playerChain[0], playerVideo);
    assert.equal(playerChain[1], playerWrap);

    // R3 regression (Codex M3b): opaque <dialog> matching <video> rect MUST NOT be bypassed
    const sameRectDialog = makeEl('DIALOG', { left: 100, top: 80, width: 640, height: 360 });
    const dialogDoc = { elementsFromPoint: () => [sameRectDialog, playerVideo, playerWrap] };
    const dialogChain = rs.collectDeepElementsAtPoint(dialogDoc, hostMock, 200, 200, 1280, 800);
    assert.equal(dialogChain[0], sameRectDialog);
    assert.equal(dialogChain.includes(playerVideo), false);

    // R3 regression (Codex M3a / Claude L9): position:fixed inside transformed overflow:hidden ancestor stays clipped
    const fixedVideo = makeEl('VIDEO', { left: 50, top: 50, width: 200, height: 120 }, { id: 'fixedVid' });
    const transformedParent = makeEl('DIV', { left: 0, top: 0, width: 100, height: 200 }, { id: 'txParent' });
    const txStack = rs.buildSmartCandidateStack([fixedVideo, transformedParent], 1280, 800, {
      getComputedStyleFn: (el) =>
        el.id === 'txParent'
          ? { display: 'block', opacity: '1', overflow: 'hidden', transform: 'translateX(0px)' }
          : { display: 'block', opacity: '1', position: 'fixed' }
    });
    assert.equal(txStack[0].rect.x, 50);
    assert.equal(txStack[0].rect.width, 50);

    // 2. C5: Carousel inner track clipped by ancestor overflow: hidden container
    const trackDiv = makeEl('DIV', { left: -200, top: 100, width: 2400, height: 300 }, { id: 'track' });
    const carouselClip = makeEl('DIV', { left: 100, top: 100, width: 400, height: 300 }, { id: 'carousel' });
    const outerSection = makeEl('SECTION', { left: 50, top: 50, width: 800, height: 500 }, { id: 'outer' });
    const clippedStack = rs.buildSmartCandidateStack([trackDiv, carouselClip, outerSection], 1280, 800, {
      getComputedStyleFn: (el) =>
        el.id === 'carousel'
          ? { display: 'block', opacity: '1', overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' }
          : { display: 'block', opacity: '1', overflow: 'visible' }
    });
    assert.equal(clippedStack.length, 2);
    assert.equal(clippedStack[0].rect.x, 100);
    assert.equal(clippedStack[0].rect.width, 400);
    assert.equal(clippedStack[1].rect.width, 800);

    // 3. Mounted interaction checks: Manual->Smart coachmark, fast click before rAF, unified ArrowUp/Down in selected, resize invalidation
    const blockA = makeEl('VIDEO', { left: 100, top: 100, width: 300, height: 200 });
    const blockAParent = makeEl('ARTICLE', { left: 80, top: 80, width: 500, height: 320 });
    blockA.parentElement = blockAParent;
    const blockB = makeEl('TABLE', { left: 700, top: 120, width: 320, height: 240 });
    env.pageDocument.elementsFromPoint = (x) => (x >= 650 ? [blockB] : [blockA, blockAParent]);

    const inst = rs.mountRegionSelector({
      tabId: 1,
      selectionToken: 'tok-r2',
      pickerMode: 'manual',
      showFirstUseHint: true,
      screenshotDataUrl: buildMinimalPngDataUrl(),
      strings: {
        regionHintDrag: 'Drag',
        regionHintSmart: 'Smart',
        regionModeSmart: 'Blocks',
        regionModeManual: 'Manual',
        regionHelpToggleAria: 'Tips',
        regionCoachTitle: 'Tip',
        regionCoachStepHover: 'H',
        regionCoachStepWheel: 'W',
        regionCoachStepClick: 'C',
        regionCoachGotIt: 'OK',
        regionBtnWider: 'Wider',
        regionBtnNarrower: 'Narrower',
        regionBtnStart: 'Start',
        regionBtnReselect: 'Reselect',
        regionBtnCancel: 'Cancel',
        regionTooSmall: 'Too small',
        regionElVideo: 'Video',
        regionElArticle: 'Article',
        regionElTable: 'Table',
        regionElBlock: 'Block'
      },
      limits: { MIN_REGION_SIZE_PX: 32, REGION_DEDUPE_TOLERANCE_PX: 4, REGION_DRAG_SWITCH_PX: 6, LOUPE_DIAMETER_PX: 136, LOUPE_ZOOM: 8 }
    });

    // Claude L-8: ? help button hidden in manual mode
    const btnHelp = inst.shadow.getElementById('btnRegionHelp');
    const coachmark = inst.shadow.getElementById('regionCoachmark');
    assert.equal(btnHelp.hidden, true);
    assert.equal(coachmark.hidden, true);

    // Codex L-3: switching Manual -> Smart displays unseen coachmark & reveals ? button
    inst.shadow.getElementById('btnRegionModeSmart').click();
    assert.equal(inst.getPickerMode(), 'smart');
    assert.equal(btnHelp.hidden, false);
    assert.equal(coachmark.hidden, false);

    // Hover over blockA (wait rAF), check data-locked is false in idle
    const overlay = findOverlayTarget(inst.shadow);
    const selBox = inst.shadow.querySelector('[data-role="selection"]');
    env.pageDocument.dispatchEvent({ type: 'pointermove', clientX: 200, clientY: 150, bubbles: true });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(inst.getRect()?.width, 300);
    assert.equal(selBox.getAttribute('data-locked'), 'false');

    // Codex M-4: Enter while focus is on btnRegionHelp in idle does NOT lock selection
    inst.shadow.activeElement = btnHelp;
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {} });
    assert.equal(selBox.getAttribute('data-locked'), 'false');
    inst.shadow.activeElement = null;

    // Codex M-1: Fast move to blockB + immediate click BEFORE rAF fires must lock blockB (320x240), not stale blockA
    env.pageDocument.dispatchEvent({ type: 'pointermove', clientX: 750, clientY: 180, bubbles: true });
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 750, clientY: 180, button: 0, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointerup', clientX: 750, clientY: 180, bubbles: true });
    assert.equal(inst.getRect()?.width, 320);
    assert.equal(selBox.getAttribute('data-locked'), 'true');

    // Re-select blockA, lock it, and verify Claude M-1: ArrowUp/ArrowDown in selected step hierarchy without wiping candidates
    inst.shadow.getElementById('btnRegionReselect').click();
    env.pageDocument.dispatchEvent({ type: 'pointermove', clientX: 200, clientY: 150, bubbles: true });
    await new Promise((r) => setTimeout(r, 25));
    overlay.dispatchEvent({ type: 'pointerdown', clientX: 200, clientY: 150, button: 0, bubbles: true });
    env.pageDocument.dispatchEvent({ type: 'pointerup', clientX: 200, clientY: 150, bubbles: true });
    assert.equal(inst.getRect()?.width, 300);
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'ArrowUp', bubbles: true, preventDefault() {} });
    assert.equal(inst.getRect()?.width, 500);
    assert.equal(inst.getSmartCandidatesCount(), 2);
    env.pageDocument.dispatchEvent({ type: 'keydown', key: 'ArrowDown', bubbles: true, preventDefault() {} });
    assert.equal(inst.getRect()?.width, 300);

    // C6: window resize invalidates cached smartCandidates
    globalThis.window.dispatchEvent({ type: 'resize' });
    assert.equal(inst.getSmartCandidatesCount(), 0);

    inst.cleanup();
  } finally {
    cleanup();
  }
});
