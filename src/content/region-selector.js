(() => {
  'use strict';

  const HOST_ID = 'webtabrec-region-host';
  const MAX_SHADOW_DEPTH = 8;
  const WHEEL_STEP_THRESHOLD = 30;
  const WHEEL_STEP_COOLDOWN_MS = 120;
  const WHEEL_ANCHOR_RADIUS_PX = 14;

  const MEDIA_OVERLAY_TAGS = new Set(['VIDEO', 'IFRAME', 'CANVAS']);
  const PRIORITY_1_TAGS = new Set(['VIDEO', 'IFRAME', 'CANVAS', 'FIGURE', 'PRE', 'TABLE', 'PICTURE']);
  const PRIORITY_2_TAGS = new Set([
    'ARTICLE',
    'SECTION',
    'MAIN',
    'ASIDE',
    'DIALOG',
    'NAV',
    'HEADER',
    'FOOTER'
  ]);
  const IGNORED_CONTAINER_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK']);

  function clamp(val, min, max) {
    if (!Number.isFinite(val)) {
      return min;
    }
    if (max < min) {
      return min;
    }
    return Math.min(max, Math.max(min, val));
  }

  function normalizeRect(startX, startY, endX, endY, vw, vh) {
    const safeVw = Math.max(1, Number.isFinite(vw) ? vw : 1);
    const safeVh = Math.max(1, Number.isFinite(vh) ? vh : 1);
    const x1 = clamp(startX, 0, safeVw);
    const y1 = clamp(startY, 0, safeVh);
    const x2 = clamp(endX, 0, safeVw);
    const y2 = clamp(endY, 0, safeVh);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const right = Math.max(x1, x2);
    const bottom = Math.max(y1, y2);
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }

  function intersectRectWithViewport(rawRect, vw, vh) {
    if (!rawRect) {
      return null;
    }
    const safeVw = Math.max(1, Number.isFinite(vw) ? vw : 1);
    const safeVh = Math.max(1, Number.isFinite(vh) ? vh : 1);
    const rawX = Number.isFinite(rawRect.left) ? rawRect.left : rawRect.x;
    const rawY = Number.isFinite(rawRect.top) ? rawRect.top : rawRect.y;
    const rawW = Number.isFinite(rawRect.width)
      ? rawRect.width
      : Number.isFinite(rawRect.right) && Number.isFinite(rawX)
        ? rawRect.right - rawX
        : 0;
    const rawH = Number.isFinite(rawRect.height)
      ? rawRect.height
      : Number.isFinite(rawRect.bottom) && Number.isFinite(rawY)
        ? rawRect.bottom - rawY
        : 0;
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || rawW <= 0 || rawH <= 0) {
      return null;
    }
    const x1 = clamp(rawX, 0, safeVw);
    const y1 = clamp(rawY, 0, safeVh);
    const x2 = clamp(rawX + rawW, 0, safeVw);
    const y2 = clamp(rawY + rawH, 0, safeVh);
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { x: x1, y: y1, width, height };
  }

  function classifyElementLabelKey(el) {
    const tag = String(el?.tagName ?? '').toUpperCase();
    const role = String(el?.getAttribute?.('role') ?? '').toLowerCase();

    if (tag === 'VIDEO') {
      return { labelKey: 'regionElVideo', priority: 1 };
    }
    if (tag === 'IFRAME') {
      return { labelKey: 'regionElFrame', priority: 1 };
    }
    if (tag === 'CANVAS') {
      return { labelKey: 'regionElCanvas', priority: 1 };
    }
    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'FIGURE' || tag === 'SVG') {
      return { labelKey: 'regionElImage', priority: 1 };
    }
    if (tag === 'TABLE' || role === 'table' || role === 'grid') {
      return { labelKey: 'regionElTable', priority: 1 };
    }
    if (tag === 'PRE' || tag === 'CODE') {
      return { labelKey: 'regionElCode', priority: 1 };
    }
    if (tag === 'DIALOG' || role === 'dialog' || role === 'alertdialog') {
      return { labelKey: 'regionElDialog', priority: 2 };
    }
    if (tag === 'ARTICLE' || role === 'article') {
      return { labelKey: 'regionElArticle', priority: 2 };
    }
    if (
      PRIORITY_2_TAGS.has(tag) ||
      role === 'region' ||
      role === 'main' ||
      role === 'complementary'
    ) {
      return { labelKey: 'regionElSection', priority: 2 };
    }
    return { labelKey: 'regionElBlock', priority: 3 };
  }

  function isVisuallyDistinctStyle(style) {
    if (!style) {
      return false;
    }
    const bg = String(style.backgroundColor ?? '').trim().toLowerCase();
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      return true;
    }
    const shadow = String(style.boxShadow ?? '').trim().toLowerCase();
    if (shadow && shadow !== 'none') {
      return true;
    }
    const borderTop = parseFloat(style.borderTopWidth);
    const borderTopStyle = String(style.borderTopStyle ?? '').toLowerCase();
    if (Number.isFinite(borderTop) && borderTop > 0 && borderTopStyle && borderTopStyle !== 'none') {
      return true;
    }
    const radius = parseFloat(style.borderRadius);
    if (Number.isFinite(radius) && radius > 0) {
      return true;
    }
    return false;
  }

  function isClippingOverflow(val) {
    const v = String(val ?? '').trim().toLowerCase();
    return v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
  }

  function createsFixedContainingBlock(style) {
    if (!style) {
      return false;
    }
    const transform = String(style.transform ?? '').trim().toLowerCase();
    if (transform && transform !== 'none') {
      return true;
    }
    const filter = String(style.filter ?? '').trim().toLowerCase();
    if (filter && filter !== 'none') {
      return true;
    }
    const backdropFilter = String(style.backdropFilter ?? '').trim().toLowerCase();
    if (backdropFilter && backdropFilter !== 'none') {
      return true;
    }
    const perspective = String(style.perspective ?? '').trim().toLowerCase();
    if (perspective && perspective !== 'none') {
      return true;
    }
    const contain = String(style.contain ?? '').trim().toLowerCase();
    if (/\b(layout|paint|strict|content)\b/.test(contain)) {
      return true;
    }
    const willChange = String(style.willChange ?? '').trim().toLowerCase();
    if (/\b(transform|filter|perspective|backdrop-filter)\b/.test(willChange)) {
      return true;
    }
    return false;
  }

  function isOpaqueOverlayElement(el, getStyleFn) {
    if (!el) {
      return false;
    }
    const tag = String(el.tagName ?? '').toUpperCase();
    const role = String(el.getAttribute?.('role') ?? '').toLowerCase();
    if (tag === 'DIALOG' || role === 'dialog' || role === 'alertdialog') {
      return true;
    }
    let style = null;
    try {
      style = typeof getStyleFn === 'function' ? getStyleFn(el) : null;
    } catch {
      style = null;
    }
    if (!style) {
      return false;
    }
    const opacity = parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0.05) {
      return false;
    }
    const bg = String(style.backgroundColor ?? '').trim().toLowerCase();
    if (!bg || bg === 'transparent') {
      return false;
    }
    const rgbaMatch = bg.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/);
    if (rgbaMatch) {
      return parseFloat(rgbaMatch[1]) > 0.25;
    }
    return true;
  }

  function intersectRects(a, b) {
    if (!a || !b) {
      return null;
    }
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1) {
      return null;
    }
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  function rectsWithinTolerance(a, b, tolerance) {
    return (
      Math.abs(a.x - b.x) <= tolerance &&
      Math.abs(a.y - b.y) <= tolerance &&
      Math.abs(a.x + a.width - (b.x + b.width)) <= tolerance &&
      Math.abs(a.y + a.height - (b.y + b.height)) <= tolerance
    );
  }

  /**
   * Builds a deduplicated, noise-filtered stack of candidate visual blocks from an
   * innermost-to-outermost DOM ancestor chain, clipping descendants against ancestor
   * overflow containers (`hidden` / `clip` / `scroll` / `auto`).
   *
   * @param {Array<Element>} elementsChain
   * @param {number} vw
   * @param {number} vh
   * @param {{ minSize?: number, dedupeTolerance?: number, getComputedStyleFn?: (el: Element) => any }} [options]
   * @returns {Array<{ element: Element, rect: { x: number, y: number, width: number, height: number }, labelKey: string, priority: number, visuallyDistinct: boolean }>}
   */
  function buildSmartCandidateStack(elementsChain, vw, vh, options = {}) {
    if (!Array.isArray(elementsChain) || elementsChain.length === 0) {
      return [];
    }
    const minSize = Number.isFinite(options.minSize) ? options.minSize : 32;
    const tol = Number.isFinite(options.dedupeTolerance) ? options.dedupeTolerance : 4;
    const getStyle =
      typeof options.getComputedStyleFn === 'function'
        ? options.getComputedStyleFn
        : typeof globalThis.window?.getComputedStyle === 'function'
          ? (el) => globalThis.window.getComputedStyle(el)
          : () => null;

    const safeVw = Math.max(1, Number.isFinite(vw) ? vw : 1);
    const safeVh = Math.max(1, Number.isFinite(vh) ? vh : 1);
    const viewportRect = { x: 0, y: 0, width: safeVw, height: safeVh };
    const viewportArea = Math.max(1, safeVw * safeVh);

    // Outermost-to-innermost pass: resolve computed styles & cumulative ancestor overflow clipping
    const metaByIndex = new Array(elementsChain.length);
    let activeClip = viewportRect;
    let hasFixedContainingBlock = false;
    for (let i = elementsChain.length - 1; i >= 0; i -= 1) {
      const el = elementsChain[i];
      if (!el || el.id === HOST_ID) {
        metaByIndex[i] = null;
        continue;
      }
      const tag = String(el.tagName ?? '').toUpperCase();
      if (!tag || IGNORED_CONTAINER_TAGS.has(tag)) {
        metaByIndex[i] = null;
        continue;
      }

      let style = null;
      try {
        style = getStyle(el);
      } catch {
        style = null;
      }

      let rawRect = null;
      try {
        rawRect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      } catch {
        rawRect = null;
      }
      const vpRect = intersectRectWithViewport(rawRect, safeVw, safeVh);
      const isFixed = String(style?.position ?? '').toLowerCase() === 'fixed';
      const escapesClip = isFixed && !hasFixedContainingBlock;
      const clippedRect = vpRect ? (escapesClip ? vpRect : intersectRects(vpRect, activeClip)) : null;

      metaByIndex[i] = { el, tag, style, rect: clippedRect };

      const clipsX = isClippingOverflow(style?.overflowX || style?.overflow);
      const clipsY = isClippingOverflow(style?.overflowY || style?.overflow);
      if (escapesClip) {
        activeClip =
          clippedRect && (clipsX || clipsY)
            ? {
                x: clipsX ? clippedRect.x : viewportRect.x,
                y: clipsY ? clippedRect.y : viewportRect.y,
                width: clipsX ? clippedRect.width : viewportRect.width,
                height: clipsY ? clippedRect.height : viewportRect.height
              }
            : viewportRect;
      } else if (clippedRect && (clipsX || clipsY)) {
        const nextX1 = clipsX ? Math.max(activeClip.x, clippedRect.x) : activeClip.x;
        const nextY1 = clipsY ? Math.max(activeClip.y, clippedRect.y) : activeClip.y;
        const nextX2 = clipsX
          ? Math.min(activeClip.x + activeClip.width, clippedRect.x + clippedRect.width)
          : activeClip.x + activeClip.width;
        const nextY2 = clipsY
          ? Math.min(activeClip.y + activeClip.height, clippedRect.y + clippedRect.height)
          : activeClip.y + activeClip.height;
        activeClip = {
          x: nextX1,
          y: nextY1,
          width: Math.max(0, nextX2 - nextX1),
          height: Math.max(0, nextY2 - nextY1)
        };
      }
      if (createsFixedContainingBlock(style)) {
        hasFixedContainingBlock = true;
      }
    }

    const stack = [];
    let fullPageFallback = null;

    for (let i = 0; i < metaByIndex.length; i += 1) {
      const entry = metaByIndex[i];
      if (!entry) {
        continue;
      }
      const { el, tag, style, rect } = entry;
      if (style) {
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          parseFloat(style.opacity) === 0
        ) {
          continue;
        }
      }

      if (!rect || rect.width < minSize || rect.height < minSize) {
        continue;
      }

      const { labelKey, priority } = classifyElementLabelKey(el);
      const visuallyDistinct = isVisuallyDistinctStyle(style);
      const candidate = {
        element: el,
        rect,
        labelKey,
        priority,
        visuallyDistinct
      };

      const areaRatio = (rect.width * rect.height) / viewportArea;
      if (areaRatio >= 0.98) {
        if (!fullPageFallback) {
          fullPageFallback = candidate;
        }
        continue;
      }

      const prev = stack[stack.length - 1];
      if (prev && rectsWithinTolerance(prev.rect, rect, tol)) {
        // Merge duplicate wrapper rects, keeping the more semantic / descriptive label
        if (candidate.priority < prev.priority) {
          prev.labelKey = candidate.labelKey;
          prev.priority = candidate.priority;
        }
        if (candidate.visuallyDistinct) {
          prev.visuallyDistinct = true;
        }
        continue;
      }

      // Skip strict shrink anomalies when traversing upward through positioned/overflow containers
      if (
        prev &&
        rect.width * rect.height < prev.rect.width * prev.rect.height * 0.9 &&
        !PRIORITY_1_TAGS.has(tag)
      ) {
        continue;
      }

      stack.push(candidate);
    }

    if (stack.length === 0 && fullPageFallback) {
      stack.push(fullPageFallback);
    }

    return stack;
  }

  /**
   * Selects the most natural initial hierarchy level for a smart candidate stack.
   *
   * @param {Array<{ priority: number, visuallyDistinct?: boolean }>} candidates
   * @returns {number}
   */
  function pickDefaultCandidateIndex(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return -1;
    }
    const p1Idx = candidates.findIndex((c) => c.priority === 1);
    if (p1Idx >= 0) {
      return p1Idx;
    }
    const p2Idx = candidates.findIndex((c) => c.priority === 2 || c.visuallyDistinct);
    if (p2Idx >= 0) {
      return p2Idx;
    }
    return 0;
  }

  function collectDeepElementsAtPoint(
    doc,
    hostEl,
    x,
    y,
    vw = 1280,
    vh = 800,
    overlayTolerance = 4,
    getStyleFn = null
  ) {
    if (!doc || typeof doc.elementsFromPoint !== 'function') {
      return [];
    }
    const prevPointerEvents = hostEl?.style?.pointerEvents ?? '';
    let hits = [];
    try {
      if (hostEl?.style) {
        if (typeof hostEl.style.setProperty === 'function') {
          hostEl.style.setProperty('pointer-events', 'none', 'important');
        } else {
          hostEl.style.pointerEvents = 'none';
        }
      }
      hits = Array.from(doc.elementsFromPoint(x, y) ?? []).filter((el) => el && el !== hostEl);

      // Descend into open Shadow DOM components (e.g. YouTube player web components)
      let depth = 0;
      while (hits.length > 0 && depth < MAX_SHADOW_DEPTH) {
        const topEl = hits[0];
        const openShadow = topEl?.shadowRoot;
        if (!openShadow || typeof openShadow.elementsFromPoint !== 'function') {
          break;
        }
        const innerHits = Array.from(openShadow.elementsFromPoint(x, y) ?? []).filter(
          (el) => el && el !== topEl && el !== hostEl
        );
        if (innerHits.length === 0 || innerHits[0] === topEl) {
          break;
        }
        hits = [...innerHits, ...hits];
        depth += 1;
      }
    } catch {
      hits = [];
    } finally {
      if (hostEl?.style) {
        if (typeof hostEl.style.setProperty === 'function') {
          hostEl.style.setProperty('pointer-events', prevPointerEvents || 'auto', 'important');
        } else {
          hostEl.style.pointerEvents = prevPointerEvents || 'auto';
        }
      }
    }

    let primary = hits[0] ?? null;
    if (!primary) {
      return [];
    }

    // Targeted player-overlay pass-through: if the top hit is a transparent, non-dialog click-capture
    // overlay with the exact same bounding box (±4px) as an underlying <video>/<iframe>/<canvas>, start
    // the ancestor chain at that media element without mixing arbitrary occluded elements below.
    const resolveStyle =
      typeof getStyleFn === 'function'
        ? getStyleFn
        : typeof globalThis.window?.getComputedStyle === 'function'
          ? (el) => globalThis.window.getComputedStyle(el)
          : null;
    const primaryTag = String(primary.tagName ?? '').toUpperCase();
    if (
      !MEDIA_OVERLAY_TAGS.has(primaryTag) &&
      !isOpaqueOverlayElement(primary, resolveStyle) &&
      hits.length > 1
    ) {
      let primaryRect = null;
      try {
        primaryRect = intersectRectWithViewport(primary.getBoundingClientRect?.(), vw, vh);
      } catch {
        primaryRect = null;
      }
      if (primaryRect) {
        for (let i = 1; i < hits.length; i += 1) {
          const candidate = hits[i];
          const cTag = String(candidate?.tagName ?? '').toUpperCase();
          if (!MEDIA_OVERLAY_TAGS.has(cTag)) {
            continue;
          }
          let cRect = null;
          try {
            cRect = intersectRectWithViewport(candidate.getBoundingClientRect?.(), vw, vh);
          } catch {
            cRect = null;
          }
          if (cRect && rectsWithinTolerance(primaryRect, cRect, overlayTolerance)) {
            primary = candidate;
            break;
          }
        }
      }
    }

    // Strictly walk the DOM/Shadow-DOM ancestor chain of `primary` (never append unrelated occluded hits).
    const seen = new Set();
    const chain = [];
    let cur = primary;
    let guard = 0;
    while (cur && guard < 80) {
      if (!seen.has(cur) && cur !== hostEl) {
        seen.add(cur);
        chain.push(cur);
      }
      if (cur.parentElement) {
        cur = cur.parentElement;
      } else if (cur.getRootNode && cur.getRootNode()?.host) {
        cur = cur.getRootNode().host;
      } else {
        cur = null;
      }
      guard += 1;
    }
    return chain;
  }

  function computeLoupePosition(
    cursorX,
    cursorY,
    vw,
    vh,
    diameter = 136,
    offset = 20,
    margin = 8,
    metaHeight = 28
  ) {
    const totalHeight = diameter + metaHeight;
    const safeVw = Math.max(diameter + margin * 2, Number.isFinite(vw) ? vw : 1280);
    const safeVh = Math.max(totalHeight + margin * 2, Number.isFinite(vh) ? vh : 800);

    let left = cursorX + offset;
    let flippedX = false;
    if (left + diameter + margin > safeVw) {
      left = cursorX - offset - diameter;
      flippedX = true;
    }

    let top = cursorY + offset;
    let flippedY = false;
    if (top + totalHeight + margin > safeVh) {
      top = cursorY - offset - totalHeight;
      flippedY = true;
    }

    left = clamp(left, margin, safeVw - diameter - margin);
    top = clamp(top, margin, safeVh - totalHeight - margin);

    return { left, top, flippedX, flippedY };
  }

  function computeLoupeSampleRect(
    cursorX,
    cursorY,
    vw,
    vh,
    imgWidth,
    imgHeight,
    diameter = 136,
    zoom = 8
  ) {
    const safeVw = Math.max(1, Number.isFinite(vw) ? vw : 1);
    const safeVh = Math.max(1, Number.isFinite(vh) ? vh : 1);
    const safeImgW = Math.max(1, Number.isFinite(imgWidth) ? imgWidth : safeVw);
    const safeImgH = Math.max(1, Number.isFinite(imgHeight) ? imgHeight : safeVh);
    const patchCss = diameter / zoom;
    const halfCss = patchCss / 2;

    const scaleX = safeImgW / safeVw;
    const scaleY = safeImgH / safeVh;

    const sw = patchCss * scaleX;
    const sh = patchCss * scaleY;
    const sx = clamp(cursorX, 0, safeVw) * scaleX - halfCss * scaleX;
    const sy = clamp(cursorY, 0, safeVh) * scaleY - halfCss * scaleY;

    return {
      sx: clamp(sx, 0, Math.max(0, safeImgW - sw)),
      sy: clamp(sy, 0, Math.max(0, safeImgH - sh)),
      sw: Math.min(sw, safeImgW),
      sh: Math.min(sh, safeImgH),
      patchCss,
      scaleX,
      scaleY
    };
  }

  function buildCropRect(rect, vw, vh, surface = null) {
    const safeVw = Math.max(1, Number.isFinite(vw) ? vw : 1);
    const safeVh = Math.max(1, Number.isFinite(vh) ? vh : 1);
    const xRatio = clamp(rect.x / safeVw, 0, 1);
    const yRatio = clamp(rect.y / safeVh, 0, 1);
    const wRatio = clamp(rect.width / safeVw, 0, 1 - xRatio);
    const hRatio = clamp(rect.height / safeVh, 0, 1 - yRatio);
    const cssAspect = safeVw / safeVh;
    let viewportAspect = cssAspect;
    let surfaceWidth = null;
    let surfaceHeight = null;
    if (
      surface &&
      Number.isFinite(surface.width) &&
      surface.width > 0 &&
      Number.isFinite(surface.height) &&
      surface.height > 0
    ) {
      const surfaceAspect = surface.width / surface.height;
      // Prefer exact physical captureVisibleTab aspect & dimensions unless resized mid-selection.
      if (Math.abs(surfaceAspect - cssAspect) / cssAspect <= 0.05) {
        viewportAspect = surfaceAspect;
        surfaceWidth = Math.round(surface.width);
        surfaceHeight = Math.round(surface.height);
      }
    }
    const result = {
      xRatio,
      yRatio,
      wRatio,
      hRatio,
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      viewportWidth: Math.round(safeVw),
      viewportHeight: Math.round(safeVh),
      viewportAspect
    };
    if (surfaceWidth !== null && surfaceHeight !== null) {
      result.surfaceWidth = surfaceWidth;
      result.surfaceHeight = surfaceHeight;
    }
    return result;
  }

  function resolveString(strings, key) {
    if (strings && typeof strings[key] === 'string' && strings[key].length > 0) {
      return strings[key];
    }
    try {
      const msg = globalThis.chrome?.i18n?.getMessage?.(key);
      if (typeof msg === 'string' && msg.length > 0) {
        return msg;
      }
    } catch {
      // ignore
    }
    return '';
  }

  function mountRegionSelector(config) {
    if (!config || !globalThis.document) {
      return null;
    }

    if (typeof globalThis.__WEBTABREC_ACTIVE_CLEANUP__ === 'function') {
      try {
        globalThis.__WEBTABREC_ACTIVE_CLEANUP__();
      } catch {
        // ignore stale cleanup failure
      }
    }

    const doc = globalThis.document;
    const existingHost = doc.getElementById?.(HOST_ID);
    if (existingHost) {
      existingHost.remove();
    }

    const limits = {
      MIN_REGION_SIZE_PX: config.limits?.MIN_REGION_SIZE_PX ?? 32,
      REGION_DEDUPE_TOLERANCE_PX: config.limits?.REGION_DEDUPE_TOLERANCE_PX ?? 4,
      REGION_DRAG_SWITCH_PX: config.limits?.REGION_DRAG_SWITCH_PX ?? 6,
      LOUPE_DIAMETER_PX: config.limits?.LOUPE_DIAMETER_PX ?? 136,
      LOUPE_ZOOM: config.limits?.LOUPE_ZOOM ?? 8
    };
    const minSize = limits.MIN_REGION_SIZE_PX;
    const dedupeTolerance = limits.REGION_DEDUPE_TOLERANCE_PX;
    const dragSwitchPx = limits.REGION_DRAG_SWITCH_PX;
    const loupeSize = limits.LOUPE_DIAMETER_PX;
    const loupeZoom = limits.LOUPE_ZOOM;
    const strings = config.strings ?? {};

    // Preserve backward compatibility for direct manual invocations without explicit pickerMode
    let pickerMode = config.pickerMode === 'smart' ? 'smart' : 'manual';
    let coachmarkVisible = pickerMode === 'smart' && Boolean(config.showFirstUseHint);
    let hintDismissNotified = !config.showFirstUseHint;

    const getViewport = () => ({
      vw: Math.max(1, globalThis.window?.innerWidth || 1280),
      vh: Math.max(1, globalThis.window?.innerHeight || 800)
    });

    const host = doc.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;z-index:2147483647 !important;margin:0 !important;padding:0 !important;border:0 !important;pointer-events:auto !important;display:block !important;';
    host.style.setProperty('z-index', '2147483647', 'important');

    const parentTarget = doc.documentElement ?? doc.body;
    parentTarget.appendChild(host);

    const shadow = host.attachShadow({ mode: 'closed' });

    const styleEl = doc.createElement('style');
    styleEl.textContent = `
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #F8FAFC;
        user-select: none;
      }
      .overlay {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        cursor: crosshair;
        display: block;
        background: rgba(15, 23, 42, 0.56);
        outline: none;
      }
      .overlay[data-picker-mode="smart"] {
        cursor: pointer;
      }
      .overlay[data-has-selection="true"] {
        background: transparent;
      }
      .top-bar {
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: calc(100vw - 24px);
        background: rgba(15, 23, 42, 0.94);
        color: #F8FAFC;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 999px;
        padding: 5px 8px 5px 6px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.38);
        pointer-events: auto;
      }
      .mode-switch {
        display: inline-flex;
        align-items: center;
        background: rgba(30, 41, 59, 0.95);
        border-radius: 999px;
        padding: 2px;
        gap: 2px;
        flex-shrink: 0;
      }
      .mode-btn {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 600;
        color: #CBD5E1;
        background: transparent;
        cursor: pointer;
        white-space: nowrap;
      }
      .mode-btn[aria-checked="true"] {
        background: #0284C7;
        color: #FFFFFF;
      }
      .mode-btn:focus-visible,
      .help-btn:focus-visible {
        outline: 2px solid #38BDF8;
        outline-offset: 2px;
      }
      .hint-pill {
        font-size: 12px;
        font-weight: 500;
        color: #E2E8F0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding: 0 4px;
      }
      .help-btn {
        appearance: none;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 1px solid rgba(148, 163, 184, 0.45);
        background: rgba(30, 41, 59, 0.9);
        color: #E2E8F0;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .coachmark {
        position: fixed;
        top: 62px;
        left: 50%;
        transform: translateX(-50%);
        width: min(440px, calc(100vw - 24px));
        background: rgba(15, 23, 42, 0.96);
        color: #F8FAFC;
        border: 1px solid rgba(56, 189, 248, 0.55);
        border-radius: 12px;
        padding: 12px 14px;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.48);
        pointer-events: auto;
      }
      .coachmark-title {
        font-size: 13px;
        font-weight: 700;
        color: #38BDF8;
        margin: 0 0 8px 0;
      }
      .coachmark-list {
        margin: 0 0 10px 0;
        padding-left: 18px;
        font-size: 12px;
        line-height: 1.5;
        color: #E2E8F0;
      }
      .coachmark-list li {
        margin-bottom: 4px;
      }
      .coachmark-footer {
        display: flex;
        justify-content: flex-end;
      }
      .too-small {
        position: fixed;
        top: 62px;
        left: 50%;
        transform: translateX(-50%);
        background: #B91C1C;
        color: #FFFFFF;
        border-radius: 10px;
        padding: 8px 14px;
        font-size: 12px;
        font-weight: 600;
        pointer-events: none;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }
      .loupe-wrap {
        position: fixed;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }
      .loupe {
        width: ${loupeSize}px;
        height: ${loupeSize}px;
        border-radius: 50%;
        border: 2px solid #38BDF8;
        background: #0F172A;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48);
        image-rendering: pixelated;
      }
      .loupe-meta {
        background: rgba(15, 23, 42, 0.92);
        color: #F8FAFC;
        border: 1px solid rgba(56, 189, 248, 0.5);
        border-radius: 6px;
        padding: 2px 8px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .selection-box {
        position: fixed;
        border: 2px solid #38BDF8;
        box-shadow: 0 0 0 99999px rgba(15, 23, 42, 0.56);
        box-sizing: border-box;
        pointer-events: none;
      }
      .selection-box[data-smart-animate="true"] {
        transition: left 80ms ease-out, top 80ms ease-out, width 80ms ease-out, height 80ms ease-out;
      }
      .size-badge {
        position: absolute;
        top: -28px;
        left: 0;
        background: rgba(15, 23, 42, 0.94);
        color: #38BDF8;
        border: 1px solid rgba(56, 189, 248, 0.4);
        border-radius: 6px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
      }
      .handle {
        display: none;
        position: absolute;
        width: 10px;
        height: 10px;
        background: #38BDF8;
        border: 1px solid #0F172A;
        border-radius: 2px;
        pointer-events: auto;
      }
      .selection-box[data-locked="true"] .handle {
        display: block;
      }
      .handle-nw { top: -5px; left: -5px; cursor: nwse-resize; }
      .handle-ne { top: -5px; right: -5px; cursor: nesw-resize; }
      .handle-sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
      .handle-se { bottom: -5px; right: -5px; cursor: nwse-resize; }
      .action-bar {
        position: fixed;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        background: #0F172A;
        border: 1px solid #475569;
        border-radius: 10px;
        padding: 6px 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
        pointer-events: auto;
      }
      .hierarchy-controls {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding-right: 6px;
        border-right: 1px solid #334155;
      }
      .btn {
        appearance: none;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 7px 11px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn:focus-visible {
        outline: 2px solid #38BDF8;
        outline-offset: 2px;
      }
      .btn-start {
        background: #DC2626;
        color: #FFFFFF;
      }
      .btn-primary {
        background: #0284C7;
        color: #FFFFFF;
      }
      .btn-secondary {
        background: #1E293B;
        color: #F8FAFC;
        border-color: #475569;
      }
      [hidden] {
        display: none !important;
      }
    `;
    shadow.appendChild(styleEl);

    const overlayEl = doc.createElement('div');
    overlayEl.className = 'overlay';
    overlayEl.setAttribute('data-role', 'overlay');
    overlayEl.setAttribute('data-picker-mode', pickerMode);
    overlayEl.setAttribute('tabindex', '-1');
    shadow.appendChild(overlayEl);

    const topBar = doc.createElement('div');
    topBar.className = 'top-bar';
    topBar.setAttribute('data-role', 'top-bar');

    const modeSwitch = doc.createElement('div');
    modeSwitch.className = 'mode-switch';
    modeSwitch.setAttribute('role', 'radiogroup');
    modeSwitch.setAttribute('data-role', 'mode-switch');

    const btnModeSmart = doc.createElement('button');
    btnModeSmart.type = 'button';
    btnModeSmart.id = 'btnRegionModeSmart';
    btnModeSmart.className = 'mode-btn';
    btnModeSmart.setAttribute('role', 'radio');
    btnModeSmart.setAttribute('data-picker-mode', 'smart');
    btnModeSmart.textContent = resolveString(strings, 'regionModeSmart');

    const btnModeManual = doc.createElement('button');
    btnModeManual.type = 'button';
    btnModeManual.id = 'btnRegionModeManual';
    btnModeManual.className = 'mode-btn';
    btnModeManual.setAttribute('role', 'radio');
    btnModeManual.setAttribute('data-picker-mode', 'manual');
    btnModeManual.textContent = resolveString(strings, 'regionModeManual');

    modeSwitch.appendChild(btnModeSmart);
    modeSwitch.appendChild(btnModeManual);

    const hintPill = doc.createElement('div');
    hintPill.className = 'hint-pill';
    hintPill.setAttribute('data-role', 'hint');

    const btnHelp = doc.createElement('button');
    btnHelp.type = 'button';
    btnHelp.id = 'btnRegionHelp';
    btnHelp.className = 'help-btn';
    btnHelp.setAttribute('data-role', 'help-toggle');
    const helpLabel = resolveString(strings, 'regionHelpToggleAria');
    if (helpLabel) {
      btnHelp.setAttribute('aria-label', helpLabel);
      btnHelp.setAttribute('title', helpLabel);
    }
    btnHelp.textContent = '?';

    topBar.appendChild(modeSwitch);
    topBar.appendChild(hintPill);
    topBar.appendChild(btnHelp);
    shadow.appendChild(topBar);

    const coachmarkEl = doc.createElement('div');
    coachmarkEl.id = 'regionCoachmark';
    coachmarkEl.className = 'coachmark';
    coachmarkEl.setAttribute('data-role', 'coachmark');
    coachmarkEl.setAttribute('role', 'dialog');
    coachmarkEl.hidden = !coachmarkVisible;

    const coachTitle = doc.createElement('div');
    coachTitle.className = 'coachmark-title';
    coachTitle.textContent = resolveString(strings, 'regionCoachTitle');

    const coachList = doc.createElement('ul');
    coachList.className = 'coachmark-list';
    for (const key of ['regionCoachStepHover', 'regionCoachStepWheel', 'regionCoachStepClick']) {
      const li = doc.createElement('li');
      li.textContent = resolveString(strings, key);
      coachList.appendChild(li);
    }

    const coachFooter = doc.createElement('div');
    coachFooter.className = 'coachmark-footer';
    const btnCoachGotIt = doc.createElement('button');
    btnCoachGotIt.type = 'button';
    btnCoachGotIt.id = 'btnRegionCoachGotIt';
    btnCoachGotIt.className = 'btn btn-primary';
    btnCoachGotIt.setAttribute('data-action', 'coach-got-it');
    btnCoachGotIt.textContent = resolveString(strings, 'regionCoachGotIt');
    coachFooter.appendChild(btnCoachGotIt);

    coachmarkEl.appendChild(coachTitle);
    coachmarkEl.appendChild(coachList);
    coachmarkEl.appendChild(coachFooter);
    shadow.appendChild(coachmarkEl);

    const tooSmallEl = doc.createElement('div');
    tooSmallEl.className = 'too-small';
    tooSmallEl.setAttribute('data-role', 'too-small');
    tooSmallEl.setAttribute('role', 'status');
    tooSmallEl.hidden = true;
    tooSmallEl.textContent = '';
    shadow.appendChild(tooSmallEl);

    const selectionBox = doc.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.setAttribute('data-role', 'selection');
    selectionBox.hidden = true;

    const sizeBadge = doc.createElement('div');
    sizeBadge.className = 'size-badge';
    selectionBox.appendChild(sizeBadge);

    for (const dir of ['nw', 'ne', 'sw', 'se']) {
      const h = doc.createElement('div');
      h.className = `handle handle-${dir}`;
      h.setAttribute('data-handle', dir);
      selectionBox.appendChild(h);
    }
    shadow.appendChild(selectionBox);

    const loupeWrap = doc.createElement('div');
    loupeWrap.className = 'loupe-wrap';
    loupeWrap.setAttribute('data-role', 'loupe-wrap');
    loupeWrap.hidden = true;

    const loupeCanvas = doc.createElement('canvas');
    loupeCanvas.className = 'loupe';
    loupeCanvas.setAttribute('data-role', 'loupe');
    loupeCanvas.width = loupeSize;
    loupeCanvas.height = loupeSize;
    loupeWrap.appendChild(loupeCanvas);

    const loupeMeta = doc.createElement('div');
    loupeMeta.className = 'loupe-meta';
    loupeMeta.setAttribute('data-role', 'loupe-meta');
    loupeWrap.appendChild(loupeMeta);
    shadow.appendChild(loupeWrap);

    const actionBar = doc.createElement('div');
    actionBar.className = 'action-bar';
    actionBar.setAttribute('data-role', 'actions');
    actionBar.hidden = true;

    const hierarchyControls = doc.createElement('div');
    hierarchyControls.className = 'hierarchy-controls';
    hierarchyControls.setAttribute('data-role', 'hierarchy-controls');
    hierarchyControls.hidden = true;

    const btnWider = doc.createElement('button');
    btnWider.type = 'button';
    btnWider.id = 'btnRegionWider';
    btnWider.className = 'btn btn-secondary';
    btnWider.setAttribute('data-action', 'wider');
    btnWider.textContent = resolveString(strings, 'regionBtnWider');
    const widerTitle = resolveString(strings, 'regionBtnWiderTitle');
    if (widerTitle) {
      btnWider.setAttribute('title', widerTitle);
    }

    const btnNarrower = doc.createElement('button');
    btnNarrower.type = 'button';
    btnNarrower.id = 'btnRegionNarrower';
    btnNarrower.className = 'btn btn-secondary';
    btnNarrower.setAttribute('data-action', 'narrower');
    btnNarrower.textContent = resolveString(strings, 'regionBtnNarrower');
    const narrowerTitle = resolveString(strings, 'regionBtnNarrowerTitle');
    if (narrowerTitle) {
      btnNarrower.setAttribute('title', narrowerTitle);
    }

    hierarchyControls.appendChild(btnWider);
    hierarchyControls.appendChild(btnNarrower);

    const btnStart = doc.createElement('button');
    btnStart.type = 'button';
    btnStart.id = 'btnRegionStart';
    btnStart.className = 'btn btn-start';
    btnStart.setAttribute('data-action', 'start');
    btnStart.textContent = resolveString(strings, 'regionBtnStart');

    const btnReselect = doc.createElement('button');
    btnReselect.type = 'button';
    btnReselect.id = 'btnRegionReselect';
    btnReselect.className = 'btn btn-secondary';
    btnReselect.setAttribute('data-action', 'reselect');
    btnReselect.textContent = resolveString(strings, 'regionBtnReselect');

    const btnCancel = doc.createElement('button');
    btnCancel.type = 'button';
    btnCancel.id = 'btnRegionCancel';
    btnCancel.className = 'btn btn-secondary';
    btnCancel.setAttribute('data-action', 'cancel');
    btnCancel.textContent = resolveString(strings, 'regionBtnCancel');

    actionBar.appendChild(hierarchyControls);
    actionBar.appendChild(btnStart);
    actionBar.appendChild(btnReselect);
    actionBar.appendChild(btnCancel);
    shadow.appendChild(actionBar);

    const loupeCtx = loupeCanvas.getContext?.('2d') ?? null;

    let pendingImg = null;
    let screenshotImg = null;
    let imageLoaded = false;
    let phase = 'idle'; // 'idle' | 'dragging' | 'resizing' | 'selected'
    let dragStart = null;
    let pendingSmartClick = null;
    let activeHandle = null;
    let currentRect = null;
    let cleanedUp = false;

    let smartCandidates = [];
    let smartCandidateIndex = -1;
    let wheelAccum = 0;
    let wheelAnchor = null;
    let lastWheelStepAt = 0;
    let lastWheelStepDir = 0;
    let pointerOverChromeUi = false;
    let pendingHoverCoords = null;
    let hoverRafId = null;

    if (config.screenshotDataUrl && typeof globalThis.Image === 'function') {
      const img = new globalThis.Image();
      pendingImg = img;
      img.onload = () => {
        if (pendingImg === img) {
          pendingImg = null;
        }
        if (cleanedUp) {
          img.onload = null;
          img.onerror = null;
          img.src = '';
          return;
        }
        screenshotImg = img;
        imageLoaded = true;
        renderOverlay();
      };
      img.onerror = () => {
        if (pendingImg === img) {
          pendingImg = null;
        }
        imageLoaded = false;
      };
      img.src = config.screenshotDataUrl;
    }

    function notifyBackground(type, extraPayload = {}) {
      try {
        const res = globalThis.chrome?.runtime?.sendMessage?.({
          target: 'background',
          type,
          payload: {
            tabId: config.tabId,
            selectionToken: config.selectionToken,
            ...extraPayload
          }
        });
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      } catch {
        // ignore
      }
    }

    function dismissCoachmark(persist = true) {
      if (coachmarkVisible) {
        coachmarkVisible = false;
        coachmarkEl.hidden = true;
        pointerOverChromeUi = false;
      }
      if (persist && !hintDismissNotified) {
        hintDismissNotified = true;
        notifyBackground('REGION_HINT_DISMISSED');
      }
    }

    function updateModeUi() {
      const isSmart = pickerMode === 'smart';
      overlayEl.setAttribute('data-picker-mode', pickerMode);
      btnModeSmart.setAttribute('aria-checked', isSmart ? 'true' : 'false');
      btnModeManual.setAttribute('aria-checked', isSmart ? 'false' : 'true');
      btnHelp.hidden = !isSmart;
      hintPill.textContent = resolveString(
        strings,
        isSmart ? 'regionHintSmart' : 'regionHintDrag'
      );
      if (!isSmart) {
        coachmarkEl.hidden = true;
        pointerOverChromeUi = false;
      } else {
        coachmarkEl.hidden = !coachmarkVisible;
      }
    }

    function updateHierarchyButtons() {
      const showHierarchy =
        phase === 'selected' && smartCandidates.length > 1 && smartCandidateIndex >= 0;
      hierarchyControls.hidden = !showHierarchy;
      if (showHierarchy) {
        btnWider.disabled = smartCandidateIndex >= smartCandidates.length - 1;
        btnNarrower.disabled = smartCandidateIndex <= 0;
      }
    }

    function setPickerMode(nextMode, { persist = true } = {}) {
      if (nextMode !== 'smart' && nextMode !== 'manual') {
        return;
      }
      if (pickerMode === nextMode) {
        return;
      }
      pickerMode = nextMode;
      resetSelection();
      loupeWrap.hidden = true;
      if (pickerMode === 'smart' && !hintDismissNotified) {
        coachmarkVisible = true;
      }
      updateModeUi();
      if (persist) {
        notifyBackground('REGION_PICKER_MODE_CHANGED', { pickerMode });
      }
    }

    function renderOverlay() {
      const hasSel = Boolean(currentRect && currentRect.width > 0 && currentRect.height > 0);
      overlayEl.setAttribute('data-has-selection', hasSel ? 'true' : 'false');
    }

    function renderSelectionBox() {
      if (!currentRect || currentRect.width <= 0 || currentRect.height <= 0) {
        selectionBox.hidden = true;
        selectionBox.setAttribute('data-locked', 'false');
        return;
      }
      selectionBox.hidden = false;
      selectionBox.setAttribute('data-locked', phase === 'selected' ? 'true' : 'false');
      const isSmartAnimated =
        pickerMode === 'smart' &&
        (phase === 'idle' || phase === 'selected') &&
        smartCandidates.length > 0 &&
        smartCandidateIndex >= 0;
      selectionBox.setAttribute('data-smart-animate', isSmartAnimated ? 'true' : 'false');
      selectionBox.style.left = `${Math.round(currentRect.x)}px`;
      selectionBox.style.top = `${Math.round(currentRect.y)}px`;
      selectionBox.style.width = `${Math.round(currentRect.width)}px`;
      selectionBox.style.height = `${Math.round(currentRect.height)}px`;

      const dimsText = `${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px`;
      const activeCand =
        smartCandidateIndex >= 0 ? smartCandidates[smartCandidateIndex] : null;
      if (activeCand) {
        const typeLabel = resolveString(strings, activeCand.labelKey);
        const levelSuffix =
          smartCandidates.length > 1
            ? ` · ${smartCandidateIndex + 1}/${smartCandidates.length}`
            : '';
        sizeBadge.textContent = typeLabel
          ? `${typeLabel} · ${dimsText}${levelSuffix}`
          : `${dimsText}${levelSuffix}`;
      } else {
        sizeBadge.textContent = dimsText;
      }
      // Keep badge visible if selection touches top edge of viewport
      sizeBadge.style.top = currentRect.y < 32 ? '6px' : '-28px';
    }

    function positionActionBar() {
      if (!currentRect) {
        actionBar.hidden = true;
        return;
      }
      updateHierarchyButtons();
      const { vw, vh } = getViewport();
      actionBar.hidden = false;
      const measured = actionBar.getBoundingClientRect?.();
      const barWidth =
        measured && Number.isFinite(measured.width) && measured.width > 0
          ? Math.max(280, Math.ceil(measured.width))
          : hierarchyControls.hidden
            ? 360
            : 480;
      const barHeight =
        measured && Number.isFinite(measured.height) && measured.height > 0
          ? Math.max(42, Math.ceil(measured.height))
          : 44;
      const left = clamp(currentRect.x, 8, Math.max(8, vw - barWidth - 8));
      let top = currentRect.y + currentRect.height + 10;
      if (top + barHeight > vh - 8) {
        top = Math.max(8, currentRect.y - barHeight - 10);
      }
      actionBar.style.left = `${Math.round(left)}px`;
      actionBar.style.top = `${Math.round(top)}px`;
    }

    function renderLoupe(clientX, clientY) {
      const { vw, vh } = getViewport();
      const pos = computeLoupePosition(clientX, clientY, vw, vh, loupeSize);
      loupeWrap.hidden = false;
      loupeWrap.style.left = `${Math.round(pos.left)}px`;
      loupeWrap.style.top = `${Math.round(pos.top)}px`;

      const cx = Math.round(clamp(clientX, 0, vw));
      const cy = Math.round(clamp(clientY, 0, vh));
      if (currentRect && (phase === 'dragging' || phase === 'resizing')) {
        loupeMeta.textContent = `${cx}, ${cy} · ${Math.round(currentRect.width)} × ${Math.round(currentRect.height)} px`;
      } else {
        loupeMeta.textContent = `${cx}, ${cy}`;
      }

      if (!loupeCtx) {
        return;
      }
      loupeCtx.imageSmoothingEnabled = false;
      loupeCtx.fillStyle = '#0F172A';
      loupeCtx.fillRect(0, 0, loupeSize, loupeSize);

      let gridStep = loupeZoom;
      if (imageLoaded && screenshotImg) {
        const imgW = screenshotImg.naturalWidth || screenshotImg.width || vw;
        const imgH = screenshotImg.naturalHeight || screenshotImg.height || vh;
        const sample = computeLoupeSampleRect(
          clientX,
          clientY,
          vw,
          vh,
          imgW,
          imgH,
          loupeSize,
          loupeZoom
        );
        const avgScale = Math.max(1, (sample.scaleX + sample.scaleY) / 2);
        gridStep = Math.max(4, loupeZoom / avgScale);
        loupeCtx.drawImage(
          screenshotImg,
          sample.sx,
          sample.sy,
          sample.sw,
          sample.sh,
          0,
          0,
          loupeSize,
          loupeSize
        );
      }

      // 1px physical pixel grid
      loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      loupeCtx.lineWidth = 1;
      for (let p = gridStep; p < loupeSize; p += gridStep) {
        loupeCtx.beginPath();
        loupeCtx.moveTo(p, 0);
        loupeCtx.lineTo(p, loupeSize);
        loupeCtx.stroke();
        loupeCtx.beginPath();
        loupeCtx.moveTo(0, p);
        loupeCtx.lineTo(loupeSize, p);
        loupeCtx.stroke();
      }

      // Center 1x1 target pixel crosshair
      const centerPx = Math.floor(loupeSize / 2 - loupeZoom / 2);
      loupeCtx.strokeStyle = '#38BDF8';
      loupeCtx.lineWidth = 1.5;
      loupeCtx.strokeRect(centerPx, centerPx, loupeZoom, loupeZoom);
    }

    function applyActiveSmartCandidate() {
      const cand = smartCandidateIndex >= 0 ? smartCandidates[smartCandidateIndex] : null;
      if (!cand) {
        currentRect = null;
        renderOverlay();
        renderSelectionBox();
        return;
      }
      currentRect = { ...cand.rect };
      renderOverlay();
      renderSelectionBox();
      if (phase === 'selected') {
        positionActionBar();
      }
    }

    function inspectSmartTargetAt(clientX, clientY) {
      if (cleanedUp || pickerMode !== 'smart' || phase !== 'idle') {
        return;
      }
      const { vw, vh } = getViewport();
      const chain = collectDeepElementsAtPoint(doc, host, clientX, clientY, vw, vh, dedupeTolerance);
      const nextStack = buildSmartCandidateStack(chain, vw, vh, {
        minSize,
        dedupeTolerance
      });
      smartCandidates = nextStack;
      smartCandidateIndex = pickDefaultCandidateIndex(nextStack);
      wheelAccum = 0;
      wheelAnchor = null;
      applyActiveSmartCandidate();
    }

    function stepHierarchy(delta) {
      if (smartCandidates.length <= 1 || smartCandidateIndex < 0) {
        return false;
      }
      const nextIdx = clamp(smartCandidateIndex + delta, 0, smartCandidates.length - 1);
      if (nextIdx === smartCandidateIndex) {
        return false;
      }
      smartCandidateIndex = nextIdx;
      dismissCoachmark(true);
      applyActiveSmartCandidate();
      return true;
    }

    function hideTooSmall() {
      tooSmallEl.hidden = true;
      tooSmallEl.textContent = '';
    }

    function showTooSmall() {
      tooSmallEl.hidden = false;
      tooSmallEl.textContent = resolveString(strings, 'regionTooSmall');
    }

    function resetSelection() {
      phase = 'idle';
      dragStart = null;
      pendingSmartClick = null;
      activeHandle = null;
      currentRect = null;
      smartCandidates = [];
      smartCandidateIndex = -1;
      wheelAccum = 0;
      wheelAnchor = null;
      selectionBox.hidden = true;
      actionBar.hidden = true;
      hierarchyControls.hidden = true;
      renderOverlay();
    }

    function cleanup() {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      if (hoverRafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(hoverRafId);
        hoverRafId = null;
      }
      doc.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('wheel', onWheel, true);
      globalThis.window?.removeEventListener?.('resize', onResize);
      if (pendingImg) {
        pendingImg.onload = null;
        pendingImg.onerror = null;
        pendingImg.src = '';
        pendingImg = null;
      }
      if (screenshotImg) {
        screenshotImg.onload = null;
        screenshotImg.onerror = null;
        screenshotImg.src = '';
        screenshotImg = null;
      }
      imageLoaded = false;
      loupeCtx?.clearRect?.(0, 0, loupeSize, loupeSize);
      try {
        delete globalThis.__WEBTABREC_REGION_CONFIG__;
      } catch {
        globalThis.__WEBTABREC_REGION_CONFIG__ = undefined;
      }
      host.remove();
      if (globalThis.__WEBTABREC_ACTIVE_CLEANUP__ === cleanup) {
        globalThis.__WEBTABREC_ACTIVE_CLEANUP__ = null;
      }
    }

    async function confirmSelection() {
      if (cleanedUp) {
        return;
      }
      const { vw, vh } = getViewport();
      if (!currentRect) {
        showTooSmall();
        return;
      }
      const x1 = clamp(currentRect.x, 0, vw);
      const y1 = clamp(currentRect.y, 0, vh);
      const x2 = clamp(currentRect.x + currentRect.width, 0, vw);
      const y2 = clamp(currentRect.y + currentRect.height, 0, vh);
      const clampedRect = {
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1)
      };
      if (clampedRect.width < minSize || clampedRect.height < minSize) {
        currentRect = clampedRect;
        resetSelection();
        showTooSmall();
        return;
      }
      const surface =
        imageLoaded &&
        screenshotImg &&
        screenshotImg.naturalWidth > 0 &&
        screenshotImg.naturalHeight > 0
          ? { width: screenshotImg.naturalWidth, height: screenshotImg.naturalHeight }
          : null;
      const cropRect = buildCropRect(clampedRect, vw, vh, surface);
      if (cropRect.wRatio <= 0 || cropRect.hRatio <= 0) {
        resetSelection();
        showTooSmall();
        return;
      }
      cleanup();
      await new Promise((resolve) => {
        if (typeof globalThis.requestAnimationFrame === 'function') {
          globalThis.requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });
      notifyBackground('REGION_SELECTED', { cropRect });
    }

    function cancelSelection() {
      if (cleanedUp) {
        return;
      }
      cleanup();
      notifyBackground('REGION_CANCELLED');
    }

    function onOverlayPointerDown(e) {
      if (!e?.isTrusted) {
        return;
      }
      if (e.button !== undefined && e.button !== 0) {
        return;
      }
      hideTooSmall();
      const cx = e.clientX ?? 0;
      const cy = e.clientY ?? 0;

      if (pickerMode === 'smart') {
        if (phase === 'selected') {
          // Clicking outside locked selection starts fresh smart hover/drag
          resetSelection();
        }
        actionBar.hidden = true;
        pendingSmartClick = { x: cx, y: cy };
        const movedOutsideWheelAnchor =
          wheelAnchor !== null &&
          Math.hypot(cx - wheelAnchor.x, cy - wheelAnchor.y) > WHEEL_ANCHOR_RADIUS_PX;
        const hasPendingHover = pendingHoverCoords !== null;
        if (hoverRafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
          globalThis.cancelAnimationFrame(hoverRafId);
          hoverRafId = null;
        }
        pendingHoverCoords = null;
        if (smartCandidates.length === 0 || hasPendingHover || movedOutsideWheelAnchor) {
          inspectSmartTargetAt(cx, cy);
        }
        return;
      }

      actionBar.hidden = true;
      smartCandidates = [];
      smartCandidateIndex = -1;
      phase = 'dragging';
      dragStart = { x: cx, y: cy };
      currentRect = normalizeRect(
        dragStart.x,
        dragStart.y,
        dragStart.x,
        dragStart.y,
        getViewport().vw,
        getViewport().vh
      );
      renderOverlay();
      renderSelectionBox();
      renderLoupe(dragStart.x, dragStart.y);
    }

    function onHandlePointerDown(e, handleDir) {
      if (!e?.isTrusted) {
        return;
      }
      if (e.button !== undefined && e.button !== 0) {
        return;
      }
      e.stopPropagation?.();
      if (phase !== 'selected' || !currentRect) {
        return;
      }
      hideTooSmall();
      actionBar.hidden = true;
      // Switching to manual handle resize clears DOM hierarchy chain
      smartCandidates = [];
      smartCandidateIndex = -1;
      phase = 'resizing';
      activeHandle = handleDir;
      const right = currentRect.x + currentRect.width;
      const bottom = currentRect.y + currentRect.height;
      if (handleDir === 'nw') {
        dragStart = { x: right, y: bottom };
      } else if (handleDir === 'ne') {
        dragStart = { x: currentRect.x, y: bottom };
      } else if (handleDir === 'sw') {
        dragStart = { x: right, y: currentRect.y };
      } else {
        dragStart = { x: currentRect.x, y: currentRect.y };
      }
      renderLoupe(e.clientX ?? 0, e.clientY ?? 0);
    }

    function isPointInsideElement(el, cx, cy) {
      if (!el || el.hidden) {
        return false;
      }
      const r = el.getBoundingClientRect?.();
      if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width <= 0 || r.height <= 0) {
        return false;
      }
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }

    function onPointerMove(e) {
      if (!e?.isTrusted) {
        return;
      }
      const cx = e.clientX ?? 0;
      const cy = e.clientY ?? 0;

      // Hybrid smart -> manual drag transition when user drags > dragSwitchPx
      if (pendingSmartClick) {
        const dist = Math.hypot(cx - pendingSmartClick.x, cy - pendingSmartClick.y);
        if (dist > dragSwitchPx) {
          dragStart = { x: pendingSmartClick.x, y: pendingSmartClick.y };
          pendingSmartClick = null;
          smartCandidates = [];
          smartCandidateIndex = -1;
          wheelAnchor = null;
          phase = 'dragging';
          dismissCoachmark(true);
          const { vw, vh } = getViewport();
          currentRect = normalizeRect(dragStart.x, dragStart.y, cx, cy, vw, vh);
          renderOverlay();
          renderSelectionBox();
          renderLoupe(cx, cy);
        }
        return;
      }

      if (phase === 'selected') {
        return;
      }

      if ((phase === 'dragging' || phase === 'resizing') && dragStart) {
        const { vw, vh } = getViewport();
        currentRect = normalizeRect(dragStart.x, dragStart.y, cx, cy, vw, vh);
        renderOverlay();
        renderSelectionBox();
        renderLoupe(cx, cy);
        return;
      }

      if (pickerMode === 'smart' && phase === 'idle') {
        // Ignore hover hit-testing while pointer rests over top-bar or coachmark UI
        // (checks pointerenter flag + bounding rects because closed Shadow DOM retargets e.target to host).
        if (
          pointerOverChromeUi ||
          isPointInsideElement(topBar, cx, cy) ||
          isPointInsideElement(coachmarkEl, cx, cy) ||
          (e.target && (topBar.contains?.(e.target) || coachmarkEl.contains?.(e.target)))
        ) {
          return;
        }
        if (
          wheelAnchor &&
          Math.hypot(cx - wheelAnchor.x, cy - wheelAnchor.y) <= WHEEL_ANCHOR_RADIUS_PX
        ) {
          return;
        }
        pendingHoverCoords = { x: cx, y: cy };
        if (typeof globalThis.requestAnimationFrame === 'function') {
          if (hoverRafId === null) {
            hoverRafId = globalThis.requestAnimationFrame(() => {
              hoverRafId = null;
              if (pendingHoverCoords) {
                const { x, y } = pendingHoverCoords;
                pendingHoverCoords = null;
                inspectSmartTargetAt(x, y);
              }
            });
          }
        } else {
          pendingHoverCoords = null;
          inspectSmartTargetAt(cx, cy);
        }
        return;
      }

      renderLoupe(cx, cy);
    }

    function onPointerUp(e) {
      if (!e?.isTrusted) {
        return;
      }

      if (pendingSmartClick) {
        const clickPos = pendingSmartClick;
        pendingSmartClick = null;
        if (smartCandidates.length === 0) {
          inspectSmartTargetAt(e.clientX ?? clickPos.x, e.clientY ?? clickPos.y);
        }
        if (!currentRect || currentRect.width < minSize || currentRect.height < minSize) {
          resetSelection();
          showTooSmall();
          return;
        }
        dismissCoachmark(true);
        loupeWrap.hidden = true;
        phase = 'selected';
        renderOverlay();
        renderSelectionBox();
        positionActionBar();
        return;
      }

      if (phase !== 'dragging' && phase !== 'resizing') {
        return;
      }
      const { vw, vh } = getViewport();
      if (dragStart && e.clientX !== undefined && e.clientY !== undefined) {
        currentRect = normalizeRect(dragStart.x, dragStart.y, e.clientX, e.clientY, vw, vh);
      }
      dragStart = null;
      activeHandle = null;
      loupeWrap.hidden = true;

      if (!currentRect || currentRect.width < minSize || currentRect.height < minSize) {
        resetSelection();
        showTooSmall();
        return;
      }

      phase = 'selected';
      renderOverlay();
      renderSelectionBox();
      positionActionBar();
    }

    function onWheel(e) {
      if (!e?.isTrusted) {
        return;
      }
      if (pickerMode !== 'smart') {
        return;
      }
      if (phase !== 'idle' && phase !== 'selected') {
        return;
      }
      e.preventDefault?.();
      e.stopPropagation?.();

      let dy = Number.isFinite(e.deltaY) ? e.deltaY : 0;
      if (dy === 0) {
        return;
      }
      if (e.deltaMode === 1) {
        dy *= 16; // DOM_DELTA_LINE
      } else if (e.deltaMode === 2) {
        dy *= 120; // DOM_DELTA_PAGE
      }
      if (phase === 'idle' && smartCandidates.length === 0 && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        inspectSmartTargetAt(e.clientX, e.clientY);
      }
      if (smartCandidates.length <= 1) {
        return;
      }
      // Reset accumulator on direction reversal for snappy feel
      if ((wheelAccum > 0 && dy < 0) || (wheelAccum < 0 && dy > 0)) {
        wheelAccum = 0;
      }
      wheelAccum += dy;
      if (Math.abs(wheelAccum) >= WHEEL_STEP_THRESHOLD) {
        const direction = wheelAccum < 0 ? 1 : -1; // Scroll UP -> wider parent, DOWN -> narrower child
        const nowMs =
          typeof globalThis.performance?.now === 'function'
            ? globalThis.performance.now()
            : Date.now();
        if (direction === lastWheelStepDir && nowMs - lastWheelStepAt < WHEEL_STEP_COOLDOWN_MS) {
          wheelAccum = 0;
          return;
        }
        wheelAccum = 0;
        lastWheelStepDir = direction;
        lastWheelStepAt = nowMs;
        if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
          wheelAnchor = { x: e.clientX, y: e.clientY };
        }
        stepHierarchy(direction);
      }
    }

    function onKeyDown(e) {
      if (!e?.isTrusted) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault?.();
        cancelSelection();
        return;
      }

      if (phase === 'idle' && (e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault?.();
        setPickerMode(pickerMode === 'smart' ? 'manual' : 'smart');
        return;
      }

      if (pickerMode === 'smart' && phase === 'idle') {
        if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === '[' || e.key === '+' || e.key === '=') {
          e.preventDefault?.();
          stepHierarchy(1);
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ']' || e.key === '-') {
          e.preventDefault?.();
          stepHierarchy(-1);
          return;
        }
      }

      if (phase === 'idle' && (e.key === ' ' || e.key === 'Enter')) {
        const activeEl = shadow.activeElement;
        if (
          activeEl === btnModeSmart ||
          activeEl === btnModeManual ||
          activeEl === btnHelp ||
          activeEl === btnCoachGotIt
        ) {
          return;
        }
        e.preventDefault?.();
        if (currentRect && currentRect.width >= minSize && currentRect.height >= minSize) {
          dismissCoachmark(true);
          phase = 'selected';
          renderOverlay();
          renderSelectionBox();
          positionActionBar();
          return;
        }
        // Keyboard-only selection initiation: create a centered starter rectangle adjustable via arrow keys
        const { vw, vh } = getViewport();
        const initW = clamp(Math.round(vw * 0.45), minSize, Math.max(minSize, vw - 16));
        const initH = clamp(Math.round(vh * 0.45), minSize, Math.max(minSize, vh - 16));
        currentRect = {
          x: Math.max(0, Math.round((vw - initW) / 2)),
          y: Math.max(0, Math.round((vh - initH) / 2)),
          width: initW,
          height: initH
        };
        smartCandidates = [];
        smartCandidateIndex = -1;
        dismissCoachmark(true);
        phase = 'selected';
        renderOverlay();
        renderSelectionBox();
        positionActionBar();
        return;
      }

      if (e.key === 'Enter' && phase === 'selected') {
        const activeEl = shadow.activeElement;
        if (
          activeEl === btnReselect ||
          activeEl === btnCancel ||
          activeEl === btnWider ||
          activeEl === btnNarrower ||
          activeEl === btnModeSmart ||
          activeEl === btnModeManual ||
          activeEl === btnHelp ||
          activeEl === btnCoachGotIt
        ) {
          return;
        }
        e.preventDefault?.();
        confirmSelection();
        return;
      }

      if (phase === 'selected' && smartCandidates.length > 1) {
        if (
          e.key === 'PageUp' ||
          e.key === '[' ||
          e.key === '+' ||
          e.key === '=' ||
          (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey)
        ) {
          e.preventDefault?.();
          stepHierarchy(1);
          return;
        }
        if (
          e.key === 'PageDown' ||
          e.key === ']' ||
          e.key === '-' ||
          (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey)
        ) {
          e.preventDefault?.();
          stepHierarchy(-1);
          return;
        }
      }

      if (phase === 'selected' && currentRect) {
        const step = e.shiftKey ? 10 : 1;
        const { vw, vh } = getViewport();
        let handled = true;
        if (e.altKey || e.ctrlKey) {
          if (e.key === 'ArrowRight') {
            currentRect.width = clamp(currentRect.width + step, minSize, Math.max(minSize, vw - currentRect.x));
          } else if (e.key === 'ArrowLeft') {
            currentRect.width = clamp(currentRect.width - step, minSize, Math.max(minSize, vw - currentRect.x));
          } else if (e.key === 'ArrowDown') {
            currentRect.height = clamp(currentRect.height + step, minSize, Math.max(minSize, vh - currentRect.y));
          } else if (e.key === 'ArrowUp') {
            currentRect.height = clamp(currentRect.height - step, minSize, Math.max(minSize, vh - currentRect.y));
          } else {
            handled = false;
          }
        } else {
          if (e.key === 'ArrowRight') {
            currentRect.x = clamp(currentRect.x + step, 0, Math.max(0, vw - currentRect.width));
          } else if (e.key === 'ArrowLeft') {
            currentRect.x = clamp(currentRect.x - step, 0, Math.max(0, vw - currentRect.width));
          } else if (e.key === 'ArrowDown') {
            currentRect.y = clamp(currentRect.y + step, 0, Math.max(0, vh - currentRect.height));
          } else if (e.key === 'ArrowUp') {
            currentRect.y = clamp(currentRect.y - step, 0, Math.max(0, vh - currentRect.height));
          } else {
            handled = false;
          }
        }
        if (handled) {
          e.preventDefault?.();
          smartCandidates = [];
          smartCandidateIndex = -1;
          renderOverlay();
          renderSelectionBox();
          positionActionBar();
        }
      }
    }

    function onResize() {
      const { vw, vh } = getViewport();
      // Invalidate cached DOM candidate rects from the previous layout geometry
      smartCandidates = [];
      smartCandidateIndex = -1;
      wheelAccum = 0;
      wheelAnchor = null;
      if (phase === 'idle' && pickerMode === 'smart') {
        currentRect = null;
        selectionBox.hidden = true;
        renderOverlay();
        return;
      }
      if (currentRect) {
        const x1 = clamp(currentRect.x, 0, vw);
        const y1 = clamp(currentRect.y, 0, vh);
        const x2 = clamp(currentRect.x + currentRect.width, 0, vw);
        const y2 = clamp(currentRect.y + currentRect.height, 0, vh);
        currentRect = {
          x: x1,
          y: y1,
          width: Math.max(0, x2 - x1),
          height: Math.max(0, y2 - y1)
        };
        if (phase === 'selected' && (currentRect.width < minSize || currentRect.height < minSize)) {
          resetSelection();
          showTooSmall();
          return;
        }
      }
      renderOverlay();
      if (phase === 'selected') {
        renderSelectionBox();
        positionActionBar();
      }
    }

    topBar.addEventListener('pointerenter', () => {
      pointerOverChromeUi = true;
    });
    topBar.addEventListener('pointerleave', () => {
      pointerOverChromeUi = false;
    });
    coachmarkEl.addEventListener('pointerenter', () => {
      pointerOverChromeUi = true;
    });
    coachmarkEl.addEventListener('pointerleave', () => {
      pointerOverChromeUi = false;
    });

    overlayEl.addEventListener('pointerdown', onOverlayPointerDown);
    for (const handleEl of selectionBox.querySelectorAll('[data-handle]')) {
      const dir = handleEl.getAttribute('data-handle');
      handleEl.addEventListener('pointerdown', (e) => onHandlePointerDown(e, dir));
    }

    btnModeSmart.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      e.stopPropagation?.();
      setPickerMode('smart');
    });
    btnModeManual.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      e.stopPropagation?.();
      setPickerMode('manual');
    });
    btnHelp.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      e.stopPropagation?.();
      coachmarkVisible = !coachmarkVisible;
      coachmarkEl.hidden = !coachmarkVisible;
    });
    btnCoachGotIt.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      e.stopPropagation?.();
      dismissCoachmark(true);
    });

    btnWider.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      e.stopPropagation?.();
      stepHierarchy(1);
    });
    btnNarrower.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      e.stopPropagation?.();
      stepHierarchy(-1);
    });
    btnStart.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      confirmSelection();
    });
    btnReselect.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      hideTooSmall();
      resetSelection();
    });
    btnCancel.addEventListener('click', (e) => {
      if (!e?.isTrusted) return;
      cancelSelection();
    });

    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
    globalThis.window?.addEventListener?.('resize', onResize);

    globalThis.__WEBTABREC_ACTIVE_CLEANUP__ = cleanup;
    updateModeUi();
    renderOverlay();
    overlayEl.focus?.();

    return {
      host,
      shadow,
      cleanup,
      getRect: () => currentRect,
      getPickerMode: () => pickerMode,
      getSmartCandidateIndex: () => smartCandidateIndex,
      getSmartCandidatesCount: () => smartCandidates.length
    };
  }

  globalThis.__WEBTABREC_REGION_SELECTOR__ = {
    clamp,
    normalizeRect,
    intersectRectWithViewport,
    classifyElementLabelKey,
    buildSmartCandidateStack,
    pickDefaultCandidateIndex,
    collectDeepElementsAtPoint,
    computeLoupePosition,
    computeLoupeSampleRect,
    buildCropRect,
    mountRegionSelector
  };

  if (globalThis.__WEBTABREC_REGION_CONFIG__) {
    const cfg = globalThis.__WEBTABREC_REGION_CONFIG__;
    try {
      delete globalThis.__WEBTABREC_REGION_CONFIG__;
    } catch {
      globalThis.__WEBTABREC_REGION_CONFIG__ = undefined;
    }
    mountRegionSelector(cfg);
  } else if (globalThis.chrome?.runtime?.sendMessage) {
    try {
      const res = globalThis.chrome.runtime.sendMessage({
        target: 'background',
        type: 'GET_REGION_SELECTION_CONFIG'
      });
      if (res && typeof res.then === 'function') {
        res
          .then((cfg) => {
            if (cfg) {
              mountRegionSelector(cfg);
            }
          })
          .catch(() => {});
      }
    } catch {
      // ignore when run outside extension context
    }
  }
})();
