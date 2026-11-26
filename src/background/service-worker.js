import {
  BADGE_CONFIG,
  DEFAULT_SETTINGS,
  ERROR_TO_I18N,
  IDB_SESSION_STATUS,
  LIMITS,
  RECORDING_STATUS,
  REGION_PICKER_MODES,
  VIDEO_QUALITY_PRESETS
} from '../shared/constants.js';
import { buildRecordingFilename } from '../shared/filename.js';
import { getMessage, loadMessages, resolveLocale } from '../shared/i18n.js';
import {
  deleteSession,
  getSession,
  listSessions,
  purgeExpiredSessions,
  updateSession
} from '../shared/idb.js';
import {
  SETTINGS_KEY,
  clearSessionState,
  getSessionState,
  getSettings,
  saveSettings,
  setSessionState
} from '../shared/settings.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const WELCOME_URL = 'src/welcome/welcome.html';
const OFFSCREEN_REASONS_KEY = 'webtabrec_offscreen_reasons';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

let initPromise = null;
let offscreenLifecycleTail = Promise.resolve();
let activeOffscreenReasons = null;
let pendingRegionSelection = null;
let activeSelectionToken = null;
let regionSelectionStartedAt = null;
let regionSelectionTimerId = null;
let recordingWatchdogTimerId = null;
let startInFlight = false;
let regionStartInFlight = false;

const swState = createInitialState();

function createInitialState() {
  return {
    status: RECORDING_STATUS.IDLE,
    sessionId: null,
    mode: DEFAULT_SETTINGS.mode,
    format: DEFAULT_SETTINGS.formatsByMode[DEFAULT_SETTINGS.mode],
    actualFormat: null,
    actualMimeType: null,
    formatFallback: false,
    videoQuality: DEFAULT_SETTINGS.videoQuality,
    keepAudio: DEFAULT_SETTINGS.keepAudio,
    cropActive: false,
    cropRect: null,
    regionPickerMode: null,
    recordedTabId: null,
    recordedTabTitle: '',
    startedAt: null,
    pausedMs: 0,
    pauseStartedAt: null,
    durationMs: 0,
    bytesRecorded: 0,
    errorCode: null,
    errorDetail: null,
    noticeCode: null,
    lastExport: null,
    recoverableSession: null
  };
}

function snapshotState() {
  return {
    status: swState.status,
    sessionId: swState.sessionId,
    mode: swState.mode,
    format: swState.format,
    actualFormat: swState.actualFormat,
    actualMimeType: swState.actualMimeType,
    formatFallback: swState.formatFallback,
    videoQuality: swState.videoQuality,
    keepAudio: swState.keepAudio,
    cropActive: swState.cropActive,
    cropRect: swState.cropRect,
    regionPickerMode: swState.regionPickerMode,
    recordedTabId: swState.recordedTabId,
    recordedTabTitle: swState.recordedTabTitle,
    startedAt: swState.startedAt,
    pausedMs: swState.pausedMs,
    durationMs: swState.durationMs,
    bytesRecorded: swState.bytesRecorded,
    errorCode: swState.errorCode,
    errorDetail: swState.errorDetail,
    noticeCode: swState.noticeCode,
    lastExport: swState.lastExport,
    recoverableSession: swState.recoverableSession
  };
}

/**
 * Validates whether a tab URL is allowed for recording (`http:`, `https:`, `file:` excluding Chrome Web Store).
 *
 * @param {string | null | undefined} url
 * @returns {{ allowed: boolean, reason?: 'UNSUPPORTED_TAB' }}
 */
export function isUrlAllowed(url) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { allowed: false, reason: 'UNSUPPORTED_TAB' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'UNSUPPORTED_TAB' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: 'UNSUPPORTED_TAB' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com') {
    return { allowed: false, reason: 'UNSUPPORTED_TAB' };
  }
  if (
    host === 'chrome.google.com' &&
    (parsed.pathname === '/webstore' || parsed.pathname.startsWith('/webstore/'))
  ) {
    return { allowed: false, reason: 'UNSUPPORTED_TAB' };
  }

  return { allowed: true };
}

/**
 * Maps `chrome.tabCapture.getMediaStreamId` errors to canonical WebTabRec error codes.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function classifyTabCaptureError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (/TAB_ALREADY_CAPTURED|active stream|already being captured/i.test(msg)) {
    return 'TAB_ALREADY_CAPTURED';
  }
  if (/NOT_INVOKED|not been invoked|invoked for the current/i.test(msg)) {
    return 'NOT_INVOKED';
  }
  if (/UNSUPPORTED_TAB|internal|Web Store|chrome:\/\/|edge:\/\/|devtools:\/\//i.test(msg)) {
    return 'UNSUPPORTED_TAB';
  }
  return 'CAPTURE_FAILED';
}

/**
 * Returns the MV3 offscreen document reasons for the given mode and purpose.
 *
 * @param {'audio' | 'video' | 'both'} mode
 * @param {'record' | 'export' | 'recovery'} [purpose='record']
 * @returns {string[]}
 */
export function getOffscreenReasonsForMode(mode, purpose = 'record') {
  if (purpose === 'export' || purpose === 'recovery') {
    return ['BLOBS'];
  }
  if (mode === 'video') {
    return ['USER_MEDIA', 'BLOBS'];
  }
  return ['USER_MEDIA', 'AUDIO_PLAYBACK', 'BLOBS'];
}

/**
 * Checks whether sufficient local browser storage quota remains before starting.
 *
 * @param {{ estimate?: () => Promise<{ quota?: number, usage?: number }> } | null | undefined} [storageApi]
 * @param {number} [minBytes=LIMITS.MIN_STORAGE_QUOTA_BYTES]
 * @returns {Promise<{ ok: boolean, remaining: number | null, errorCode?: 'STORAGE_QUOTA_EXCEEDED' }>}
 */
export async function checkStorageQuota(
  storageApi = globalThis.navigator?.storage,
  minBytes = LIMITS.MIN_STORAGE_QUOTA_BYTES
) {
  if (!storageApi || typeof storageApi.estimate !== 'function') {
    return { ok: true, remaining: null };
  }
  try {
    const estimate = await storageApi.estimate();
    if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) {
      const remaining = estimate.quota - estimate.usage;
      if (remaining < minBytes) {
        return {
          ok: false,
          remaining,
          errorCode: 'QUOTA_LOW_PRESTART'
        };
      }
      return { ok: true, remaining };
    }
  } catch {
    // Allow start if estimate() is unsupported
  }
  return { ok: true, remaining: null };
}

/**
 * Computes extension icon badge text/colors and localized action title for the current state.
 *
 * @param {{ status: string, recordedTabTitle?: string, errorCode?: string | null }} state
 * @param {(key: string, substitutions?: any) => string} [translate=getMessage]
 * @returns {{ badgeText: string, badgeBg: string | null, badgeFg: string | null, title: string }}
 */
export function buildActionPresentation(state, translate = getMessage) {
  const badge = BADGE_CONFIG[state?.status] ?? BADGE_CONFIG.IDLE;
  const fallbackTitle = translate('fallbackTabTitle') || 'tab';
  let title = '';

  if (state?.status === RECORDING_STATUS.RECORDING) {
    title = translate('actionTitleRecording', [state.recordedTabTitle || fallbackTitle]);
  } else if (state?.status === RECORDING_STATUS.PAUSED) {
    title = translate('actionTitlePaused', [state.recordedTabTitle || fallbackTitle]);
  } else if (state?.status === RECORDING_STATUS.ERROR) {
    const errKey = ERROR_TO_I18N[state.errorCode];
    title = (errKey ? translate(errKey) : '') || translate('actionTitle');
  } else {
    title = translate('actionTitle');
  }

  return {
    badgeText: badge.text ?? '',
    badgeBg: badge.bg ?? null,
    badgeFg: badge.fg ?? null,
    title: title || 'WebTabRec'
  };
}

async function refreshI18n() {
  try {
    const settings = await getSettings();
    const locale = resolveLocale(settings.locale);
    await loadMessages(locale);
    return settings;
  } catch {
    await loadMessages('en').catch(() => {});
    return DEFAULT_SETTINGS;
  }
}

async function applyActionPresentation() {
  const action = globalThis.chrome?.action;
  if (!action) {
    return;
  }
  const { badgeText, badgeBg, badgeFg, title } = buildActionPresentation(swState, getMessage);
  try {
    await action.setBadgeText?.({ text: badgeText });
    if (badgeBg) {
      await action.setBadgeBackgroundColor?.({ color: badgeBg });
    }
    if (badgeFg) {
      await action.setBadgeTextColor?.({ color: badgeFg });
    }
    await action.setTitle?.({ title });
  } catch {
    // Ignore transient action errors
  }
}

function broadcastStateUpdate() {
  try {
    const res = globalThis.chrome?.runtime?.sendMessage?.({
      target: 'popup',
      type: 'STATE_UPDATE',
      payload: snapshotState()
    });
    if (res && typeof res.catch === 'function') {
      res.catch(() => {});
    }
  } catch {
    // Popup is closed ("Receiving end does not exist")
  }
}

async function persistSessionState() {
  try {
    if (swState.status === RECORDING_STATUS.IDLE) {
      await clearSessionState();
    } else {
      const stateToSave = snapshotState();
      if (swState.status === RECORDING_STATUS.SELECTING_REGION) {
        if (activeSelectionToken) {
          stateToSave._selectionToken = activeSelectionToken;
        }
        if (Number.isFinite(regionSelectionStartedAt)) {
          stateToSave.regionSelectionStartedAt = regionSelectionStartedAt;
        }
      }
      await setSessionState(stateToSave);
    }
  } catch {
    // Ignore storage session failure in degraded contexts
  }
}

function withOffscreenLock(fn) {
  const run = offscreenLifecycleTail.then(fn, fn);
  offscreenLifecycleTail = run.catch(() => {});
  return run;
}

async function hasOffscreenDocument() {
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.getContexts === 'function') {
    try {
      const offscreenUrl = runtime.getURL?.(OFFSCREEN_URL);
      const contexts = await runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        ...(offscreenUrl ? { documentUrls: [offscreenUrl] } : {})
      });
      return Array.isArray(contexts) && contexts.length > 0;
    } catch {
      // Fallback below
    }
  }
  if (typeof globalThis.chrome?.offscreen?.hasDocument === 'function') {
    try {
      return await globalThis.chrome.offscreen.hasDocument();
    } catch {
      return false;
    }
  }
  return false;
}

async function getPersistedOffscreenReasons() {
  if (Array.isArray(activeOffscreenReasons)) {
    return activeOffscreenReasons;
  }
  try {
    const sessionArea = globalThis.chrome?.storage?.session;
    if (typeof sessionArea?.get === 'function') {
      const res = await sessionArea.get(OFFSCREEN_REASONS_KEY);
      const stored = res?.[OFFSCREEN_REASONS_KEY];
      if (Array.isArray(stored)) {
        activeOffscreenReasons = [...stored];
        return activeOffscreenReasons;
      }
    }
  } catch {
    // Ignore storage session failure in degraded contexts
  }
  return null;
}

async function setPersistedOffscreenReasons(reasons) {
  activeOffscreenReasons = Array.isArray(reasons) ? [...reasons] : null;
  try {
    const sessionArea = globalThis.chrome?.storage?.session;
    if (!sessionArea) {
      return;
    }
    if (activeOffscreenReasons) {
      await sessionArea.set?.({ [OFFSCREEN_REASONS_KEY]: activeOffscreenReasons });
    } else {
      await sessionArea.remove?.(OFFSCREEN_REASONS_KEY);
    }
  } catch {
    // Ignore storage session failure in degraded contexts
  }
}

async function ensureOffscreenDocument(reasons, justification) {
  return withOffscreenLock(async () => {
    if (await hasOffscreenDocument()) {
      const knownReasons = await getPersistedOffscreenReasons();
      const requestedExceedsBlobs = reasons.some((r) => r !== 'BLOBS');
      const needsUpgrade = Array.isArray(knownReasons)
        ? reasons.some((r) => !knownReasons.includes(r))
        : requestedExceedsBlobs;
      if (!needsUpgrade) {
        return;
      }
      try {
        const status = await sendToOffscreen('OFFSCREEN_GET_STATUS');
        if (
          status &&
          !status.active &&
          !status.savingSessionId &&
          (status.exportsInFlight ?? 0) === 0
        ) {
          await globalThis.chrome.offscreen?.closeDocument?.();
          await setPersistedOffscreenReasons(null);
        } else {
          return;
        }
      } catch {
        await setPersistedOffscreenReasons(null);
      }
    }

    if (await hasOffscreenDocument()) {
      return;
    }

    try {
      await globalThis.chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons,
        justification
      });
      await setPersistedOffscreenReasons(reasons);
    } catch (err) {
      if (!/Only a single offscreen document/i.test(String(err?.message ?? ''))) {
        throw err;
      }
    }
  });
}

async function sendToOffscreen(type, payload) {
  return globalThis.chrome.runtime.sendMessage({
    target: 'offscreen',
    type,
    payload
  });
}

async function maybeCloseIdleOffscreen() {
  if (startInFlight || isBusyRecordingState(swState.status)) {
    return;
  }
  return withOffscreenLock(async () => {
    if (startInFlight || isBusyRecordingState(swState.status)) {
      return;
    }
    if (!(await hasOffscreenDocument())) {
      await setPersistedOffscreenReasons(null);
      return;
    }
    try {
      const status = await sendToOffscreen('OFFSCREEN_GET_STATUS');
      if (
        status &&
        !status.active &&
        (status.pendingExportsCount ?? 0) === 0 &&
        (status.exportsInFlight ?? 0) === 0
      ) {
        await globalThis.chrome.offscreen?.closeDocument?.();
        await setPersistedOffscreenReasons(null);
      }
    } catch {
      // Ignore if offscreen already closed
    }
  });
}

function clearRegionSelectionTimer() {
  if (regionSelectionTimerId !== null) {
    clearTimeout(regionSelectionTimerId);
    regionSelectionTimerId = null;
  }
}

function stopRecordingWatchdog() {
  if (recordingWatchdogTimerId !== null) {
    clearInterval(recordingWatchdogTimerId);
    recordingWatchdogTimerId = null;
  }
}

function startRecordingWatchdog() {
  stopRecordingWatchdog();
  recordingWatchdogTimerId = setInterval(() => {
    if (
      swState.status !== RECORDING_STATUS.RECORDING &&
      swState.status !== RECORDING_STATUS.PAUSED
    ) {
      stopRecordingWatchdog();
      return;
    }
    (async () => {
      const open = await hasOffscreenDocument();
      if (!open) {
        await handleOffscreenLost(swState.sessionId);
        return;
      }
      const status = await sendToOffscreen('OFFSCREEN_GET_STATUS').catch(() => null);
      if (!status) {
        await handleOffscreenLost(swState.sessionId);
        return;
      }
      if (!status.active) {
        const isSavingThisSession =
          (status.exportsInFlight ?? 0) > 0 ||
          (status.savingSessionId && status.savingSessionId === swState.sessionId) ||
          (Array.isArray(status.savingSessionIds) &&
            swState.sessionId &&
            status.savingSessionIds.includes(swState.sessionId));
        if (isSavingThisSession) {
          if (
            swState.status === RECORDING_STATUS.RECORDING ||
            swState.status === RECORDING_STATUS.PAUSED
          ) {
            swState.status = RECORDING_STATUS.SAVING;
            stopRecordingWatchdog();
            await persistSessionState();
            await applyActionPresentation();
            broadcastStateUpdate();
          }
          return;
        }
        await handleOffscreenLost(swState.sessionId);
      }
    })().catch(() => {});
  }, 5000);
  recordingWatchdogTimerId?.unref?.();
}

function resetStateToIdle() {
  stopRecordingWatchdog();
  clearRegionSelectionTimer();
  pendingRegionSelection = null;
  activeSelectionToken = null;
  regionSelectionStartedAt = null;
  const initial = createInitialState();
  Object.assign(swState, initial);
}

async function enterErrorState(errorCode, detail = null) {
  stopRecordingWatchdog();
  clearRegionSelectionTimer();
  pendingRegionSelection = null;
  activeSelectionToken = null;
  regionSelectionStartedAt = null;
  swState.status = RECORDING_STATUS.ERROR;
  swState.sessionId = null;
  swState.cropActive = false;
  swState.cropRect = null;
  swState.regionPickerMode = null;
  swState.recordedTabId = null;
  swState.recordedTabTitle = '';
  swState.startedAt = null;
  swState.pausedMs = 0;
  swState.pauseStartedAt = null;
  swState.durationMs = 0;
  swState.bytesRecorded = 0;
  swState.errorCode = errorCode;
  swState.errorDetail = detail;
  await persistSessionState();
  await applyActionPresentation();
  broadcastStateUpdate();
}

async function reconcileIdbSessions(excludeSessionIds = new Set()) {
  let sessions = [];
  try {
    sessions = await listSessions();
  } catch {
    sessions = [];
  }

  const now = Date.now();
  const pendingUpdates = [];
  for (const session of sessions) {
    if (excludeSessionIds.has(session.sessionId)) {
      continue;
    }
    if (session.incognito) {
      pendingUpdates.push(deleteSession(session.sessionId).catch(() => {}));
      session.status = IDB_SESSION_STATUS.DISCARDED;
      continue;
    }

    const isUnrecoverableWebCodecs =
      session.encoder === 'webcodecs' && !session.hasMp4Meta && !session.mp4Meta;

    if (session.status === IDB_SESSION_STATUS.ACTIVE) {
      const endedAt = session.lastWriteAt ?? session.startedAt ?? now;
      const isExpired = now - endedAt > LIMITS.SESSION_RETENTION_MS;
      if (!isExpired && (session.bytesRecorded ?? 0) > 0 && !isUnrecoverableWebCodecs) {
        pendingUpdates.push(
          updateSession(session.sessionId, {
            status: IDB_SESSION_STATUS.INTERRUPTED,
            endedAt
          }).catch(() => {})
        );
        session.status = IDB_SESSION_STATUS.INTERRUPTED;
        session.endedAt = endedAt;
      } else {
        pendingUpdates.push(deleteSession(session.sessionId).catch(() => {}));
        session.status = IDB_SESSION_STATUS.DISCARDED;
      }
    } else {
      const refTime =
        session.endedAt ?? session.lastWriteAt ?? session.startedAt ?? 0;
      const isExpired = now - refTime > LIMITS.SESSION_RETENTION_MS;
      const isAbandonedEmpty = (session.bytesRecorded ?? 0) === 0;
      if (isExpired || isAbandonedEmpty || isUnrecoverableWebCodecs) {
        pendingUpdates.push(deleteSession(session.sessionId).catch(() => {}));
        session.status = IDB_SESSION_STATUS.DISCARDED;
      }
    }
  }

  const recoverable = sessions
    .filter((s) => {
      if (s.incognito || s.status !== IDB_SESSION_STATUS.INTERRUPTED || (s.bytesRecorded ?? 0) <= 0) {
        return false;
      }
      const refTime = s.lastWriteAt ?? s.endedAt ?? s.startedAt ?? now;
      return now - refTime < LIMITS.SESSION_RETENTION_MS;
    })
    .sort((a, b) => (b.lastWriteAt ?? b.startedAt ?? 0) - (a.lastWriteAt ?? a.startedAt ?? 0));

  const savedUnconfirmed = sessions
    .filter((s) => {
      if (
        s.incognito ||
        s.status !== IDB_SESSION_STATUS.SAVED_UNCONFIRMED ||
        (s.bytesRecorded ?? 0) <= 0
      ) {
        return false;
      }
      const refTime = s.endedAt ?? s.lastWriteAt ?? s.startedAt ?? now;
      return now - refTime < LIMITS.SESSION_RETENTION_MS;
    })
    .sort((a, b) => (b.endedAt ?? b.lastWriteAt ?? 0) - (a.endedAt ?? a.lastWriteAt ?? 0));

  return { sessions, recoverable, savedUnconfirmed, pendingUpdates, now };
}

async function handleOffscreenLost(lostSessionId, detail = null) {
  if (
    swState.status === RECORDING_STATUS.ERROR &&
    swState.errorCode === 'OFFSCREEN_LOST'
  ) {
    return;
  }
  if (lostSessionId && swState.sessionId && swState.sessionId !== lostSessionId) {
    return;
  }
  await setPersistedOffscreenReasons(null);
  const { recoverable, pendingUpdates } = await reconcileIdbSessions();
  await Promise.all(pendingUpdates);
  swState.recoverableSession = recoverable[0] ?? null;
  await enterErrorState('OFFSCREEN_LOST', detail);
}

async function cancelRegionSelection({ removeOverlay = true } = {}) {
  if (swState.status !== RECORDING_STATUS.SELECTING_REGION) {
    return false;
  }
  const expectedTabId = pendingRegionSelection?.tabId ?? swState.recordedTabId;
  if (
    removeOverlay &&
    typeof expectedTabId === 'number' &&
    globalThis.chrome?.scripting?.executeScript
  ) {
    await globalThis.chrome.scripting
      .executeScript({
        target: { tabId: expectedTabId },
        func: () => globalThis.__WEBTABREC_ACTIVE_CLEANUP__?.()
      })
      .catch(() => {});
  }
  if (swState.status !== RECORDING_STATUS.SELECTING_REGION) {
    return false;
  }
  resetStateToIdle();
  await persistSessionState();
  await applyActionPresentation();
  broadcastStateUpdate();
  return true;
}

async function runInitialization() {
  const i18nPromise = refreshI18n();
  const offscreenOpen = await hasOffscreenDocument();
  const activeExportIds = new Set();

  if (offscreenOpen) {
    try {
      const offStatus = await sendToOffscreen('OFFSCREEN_GET_STATUS');
      if (Array.isArray(offStatus?.savingSessionIds)) {
        for (const sid of offStatus.savingSessionIds) {
          if (sid) activeExportIds.add(sid);
        }
      }
      if (offStatus?.savingSessionId) {
        activeExportIds.add(offStatus.savingSessionId);
      }

      if (offStatus?.active && offStatus.activeSessionId) {
        await i18nPromise;
        const [savedSession, idbSession] = await Promise.all([
          getSessionState().catch(() => null),
          getSession(offStatus.activeSessionId).catch(() => null)
        ]);
        swState.status =
          offStatus.state || savedSession?.status || RECORDING_STATUS.RECORDING;
        swState.sessionId = offStatus.activeSessionId;
        swState.mode = idbSession?.mode ?? savedSession?.mode ?? swState.mode;
        swState.format = idbSession?.format ?? savedSession?.format ?? swState.format;
        swState.actualFormat = idbSession?.format ?? savedSession?.actualFormat ?? null;
        swState.actualMimeType =
          idbSession?.mimeType ?? savedSession?.actualMimeType ?? null;
        swState.formatFallback = Boolean(savedSession?.formatFallback);
        swState.keepAudio =
          typeof savedSession?.keepAudio === 'boolean' ? savedSession.keepAudio : true;
        swState.cropActive = Boolean(savedSession?.cropActive);
        swState.cropRect = savedSession?.cropRect ?? null;
        swState.recordedTabId = savedSession?.recordedTabId ?? null;
        swState.recordedTabTitle =
          idbSession?.tabTitle ?? savedSession?.recordedTabTitle ?? '';
        swState.startedAt =
          idbSession?.startedAt ?? savedSession?.startedAt ?? Date.now();
        swState.pausedMs = savedSession?.pausedMs ?? 0;
        swState.pauseStartedAt = savedSession?.pauseStartedAt ?? null;
        swState.durationMs =
          idbSession?.durationMs ?? savedSession?.durationMs ?? 0;
        swState.bytesRecorded =
          idbSession?.bytesRecorded ?? savedSession?.bytesRecorded ?? 0;
        swState.errorCode = null;
        swState.errorDetail = null;
        swState.recoverableSession = null;

        await Promise.all([
          persistSessionState(),
          applyActionPresentation(),
          purgeExpiredSessions(Date.now(), LIMITS.SESSION_RETENTION_MS).catch(() => {})
        ]);
        startRecordingWatchdog();
        return;
      }

      if (activeExportIds.size > 0 || (offStatus?.exportsInFlight ?? 0) > 0) {
        await i18nPromise;
        const savingId = offStatus?.savingSessionId ?? [...activeExportIds][0] ?? null;
        const [savedSession, idbSession] = await Promise.all([
          getSessionState().catch(() => null),
          savingId ? getSession(savingId).catch(() => null) : Promise.resolve(null)
        ]);
        swState.status = RECORDING_STATUS.SAVING;
        swState.sessionId = savingId ?? savedSession?.sessionId ?? null;
        swState.mode = idbSession?.mode ?? savedSession?.mode ?? swState.mode;
        swState.format = idbSession?.format ?? savedSession?.format ?? swState.format;
        swState.actualFormat = idbSession?.format ?? savedSession?.actualFormat ?? null;
        swState.recordedTabId = savedSession?.recordedTabId ?? null;
        swState.recordedTabTitle =
          idbSession?.tabTitle ?? savedSession?.recordedTabTitle ?? '';
        swState.durationMs =
          idbSession?.durationMs ?? savedSession?.durationMs ?? 0;
        swState.bytesRecorded =
          idbSession?.bytesRecorded ?? savedSession?.bytesRecorded ?? 0;
        swState.errorCode = null;
        swState.errorDetail = null;
        swState.recoverableSession = null;
        await Promise.all([
          persistSessionState(),
          applyActionPresentation()
        ]);
        return;
      }
    } catch {
      // Offscreen lost / unresponsive; fall through to IDB reconciliation
    }
  }

  const { sessions, recoverable, savedUnconfirmed, pendingUpdates } =
    await reconcileIdbSessions(activeExportIds);

  await i18nPromise;

  if (recoverable.length > 0) {
    resetStateToIdle();
    swState.status = RECORDING_STATUS.RECOVERY;
    swState.recoverableSession = recoverable[0];
    await Promise.all([
      ...pendingUpdates,
      persistSessionState(),
      applyActionPresentation()
    ]);
    return;
  }

  const savedSession = await getSessionState().catch(() => null);
  if (savedSession?.status === RECORDING_STATUS.ERROR && savedSession?.errorCode) {
    Object.assign(swState, createInitialState(), {
      status: RECORDING_STATUS.ERROR,
      errorCode: savedSession.errorCode,
      errorDetail: savedSession.errorDetail ?? null,
      lastExport: savedSession.lastExport ?? null,
      recoverableSession: savedSession.recoverableSession ?? null
    });
    await Promise.all([
      ...pendingUpdates,
      applyActionPresentation()
    ]);
    return;
  }

  if (
    savedSession?.status === RECORDING_STATUS.COMPLETED &&
    savedSession?.lastExport?.sessionId
  ) {
    const expSession = sessions.find(
      (s) => s.sessionId === savedSession.lastExport.sessionId
    );
    if (
      expSession &&
      !expSession.incognito &&
      expSession.status === IDB_SESSION_STATUS.SAVED_UNCONFIRMED
    ) {
      Object.assign(swState, createInitialState(), {
        status: RECORDING_STATUS.COMPLETED,
        lastExport: savedSession.lastExport,
        noticeCode: savedSession.noticeCode ?? null
      });
      await Promise.all([
        ...pendingUpdates,
        applyActionPresentation()
      ]);
      return;
    }
  }

  if (savedSession?.status === RECORDING_STATUS.SELECTING_REGION) {
    const savedStartedAt = Number.isFinite(savedSession.regionSelectionStartedAt)
      ? savedSession.regionSelectionStartedAt
      : null;
    const elapsedMs = savedStartedAt != null ? Math.max(0, Date.now() - savedStartedAt) : 0;
    const selectionExpired =
      savedStartedAt != null && elapsedMs >= LIMITS.REGION_SELECTION_TIMEOUT_MS;

    if (selectionExpired) {
      if (
        typeof savedSession.recordedTabId === 'number' &&
        globalThis.chrome?.scripting?.executeScript
      ) {
        await globalThis.chrome.scripting
          .executeScript({
            target: { tabId: savedSession.recordedTabId },
            func: () => globalThis.__WEBTABREC_ACTIVE_CLEANUP__?.()
          })
          .catch(() => {});
      }
    } else {
      let tabStillValid = true;
      if (typeof savedSession.recordedTabId === 'number' && globalThis.chrome?.tabs?.get) {
        tabStillValid = await globalThis.chrome.tabs
          .get(savedSession.recordedTabId)
          .then((t) => Boolean(t && t.active !== false && isUrlAllowed(t.url).allowed))
          .catch(() => false);
      }
      if (tabStillValid) {
        activeSelectionToken = savedSession._selectionToken ?? null;
        regionSelectionStartedAt = savedStartedAt ?? Date.now();
        const remainingTimeoutMs = Math.max(
          1000,
          LIMITS.REGION_SELECTION_TIMEOUT_MS - elapsedMs
        );
        const restoredMode = savedSession.mode ?? DEFAULT_SETTINGS.mode;
        const restoredQuality =
          typeof savedSession.videoQuality === 'string' &&
          Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, savedSession.videoQuality)
            ? savedSession.videoQuality
            : DEFAULT_SETTINGS.videoQuality;
        const restoredPickerMode =
          savedSession.regionPickerMode === REGION_PICKER_MODES.SMART ||
          savedSession.regionPickerMode === REGION_PICKER_MODES.MANUAL
            ? savedSession.regionPickerMode
            : DEFAULT_SETTINGS.regionPickerMode;
        Object.assign(swState, createInitialState(), {
          status: RECORDING_STATUS.SELECTING_REGION,
          mode: restoredMode,
          format:
            savedSession.format ??
            DEFAULT_SETTINGS.formatsByMode[restoredMode],
          videoQuality: restoredQuality,
          regionPickerMode: restoredPickerMode,
          keepAudio:
            typeof savedSession.keepAudio === 'boolean'
              ? savedSession.keepAudio
              : DEFAULT_SETTINGS.keepAudio,
          recordedTabId: savedSession.recordedTabId ?? null,
          recordedTabTitle: savedSession.recordedTabTitle ?? ''
        });
        clearRegionSelectionTimer();
        regionSelectionTimerId = setTimeout(() => {
          cancelRegionSelection().catch(() => {});
        }, remainingTimeoutMs);
        regionSelectionTimerId?.unref?.();
        await Promise.all([
          ...pendingUpdates,
          applyActionPresentation()
        ]);
        return;
      }
    }
  }

  if (savedUnconfirmed.length > 0) {
    const exp = savedUnconfirmed[0];
    const reconstructedExport = {
      sessionId: exp.sessionId,
      filename: buildRecordingFilename({
        tabTitle: exp.tabTitle,
        format: exp.format,
        date: new Date(exp.endedAt ?? exp.lastWriteAt ?? Date.now())
      }),
      bytes: exp.bytesRecorded ?? 0,
      durationMs: exp.durationMs ?? 0,
      reason: 'user_stop',
      actualFormat: exp.format
    };
    Object.assign(swState, createInitialState(), {
      status: RECORDING_STATUS.COMPLETED,
      lastExport: reconstructedExport
    });
    await Promise.all([
      ...pendingUpdates,
      persistSessionState(),
      applyActionPresentation()
    ]);
    return;
  }

  resetStateToIdle();
  await Promise.all([
    ...pendingUpdates,
    persistSessionState(),
    applyActionPresentation()
  ]);
}

export function ensureInitialized() {
  if (!initPromise) {
    initPromise = runInitialization().catch((err) => {
      console.error('WebTabRec initialization failed:', err);
      initPromise = null;
    });
  }
  return initPromise;
}

async function resolveTargetTab(tabId) {
  if (typeof tabId === 'number') {
    return globalThis.chrome.tabs.get(tabId);
  }
  const activeTabs = await globalThis.chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return activeTabs?.[0] ?? null;
}

function isBusyRecordingState(status) {
  return (
    status === RECORDING_STATUS.STARTING ||
    status === RECORDING_STATUS.RECORDING ||
    status === RECORDING_STATUS.PAUSED ||
    status === RECORDING_STATUS.SAVING
  );
}

async function startRecordingFlow({
  tabId,
  mode,
  format,
  keepAudio,
  videoQuality,
  cropRect = null
}) {
  if (
    startInFlight ||
    regionStartInFlight ||
    isBusyRecordingState(swState.status) ||
    swState.status === RECORDING_STATUS.SELECTING_REGION
  ) {
    return { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' };
  }
  startInFlight = true;

  try {
    let tab;
    try {
      tab = await resolveTargetTab(tabId);
    } catch {
      tab = null;
    }

    const urlCheck = isUrlAllowed(tab?.url);
    if (!tab || !urlCheck.allowed) {
      await enterErrorState('UNSUPPORTED_TAB');
      return { ok: false, errorCode: 'UNSUPPORTED_TAB' };
    }

    const quota = await checkStorageQuota();
    if (!quota.ok) {
      await enterErrorState(quota.errorCode);
      return { ok: false, errorCode: quota.errorCode };
    }

    const prevExportSessionId = swState.lastExport?.sessionId ?? null;

    const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
    const resolvedMode = mode ?? settings.mode;
    const resolvedFormat = format ?? settings.formatsByMode[resolvedMode] ?? 'webm';
    const resolvedVideoQuality =
      typeof videoQuality === 'string' &&
      Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, videoQuality)
        ? videoQuality
        : settings.videoQuality ?? DEFAULT_SETTINGS.videoQuality;
    const resolvedKeepAudio =
      typeof keepAudio === 'boolean' ? keepAudio : settings.keepAudio;
    const sessionId =
      globalThis.crypto?.randomUUID?.() ??
      `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    swState.status = RECORDING_STATUS.STARTING;
    swState.sessionId = sessionId;
    swState.mode = resolvedMode;
    swState.format = resolvedFormat;
    swState.actualFormat = null;
    swState.actualMimeType = null;
    swState.formatFallback = false;
    swState.videoQuality = resolvedVideoQuality;
    swState.keepAudio = resolvedKeepAudio;
    swState.cropActive = Boolean(cropRect);
    swState.cropRect = cropRect;
    swState.regionPickerMode = null;
    swState.recordedTabId = tab.id;
    swState.recordedTabTitle = tab.title ?? '';
    swState.startedAt = null;
    swState.pausedMs = 0;
    swState.pauseStartedAt = null;
    swState.durationMs = 0;
    swState.bytesRecorded = 0;
    swState.errorCode = null;
    swState.errorDetail = null;
    swState.noticeCode = null;
    swState.recoverableSession = null;

    await persistSessionState();
    broadcastStateUpdate();

    try {
      await ensureOffscreenDocument(
        getOffscreenReasonsForMode(resolvedMode, 'record'),
        'Record audio and/or video from the active browser tab'
      );
    } catch (err) {
      await enterErrorState('OFFSCREEN_LOST', err?.message);
      return { ok: false, errorCode: 'OFFSCREEN_LOST', detail: err?.message };
    }

    let streamId;
    try {
      streamId = await globalThis.chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id
      });
    } catch (err) {
      const errorCode = classifyTabCaptureError(err);
      await enterErrorState(errorCode, err?.message);
      await maybeCloseIdleOffscreen();
      return { ok: false, errorCode, detail: err?.message };
    }

    const viewportAspect =
      Number.isFinite(cropRect?.viewportAspect) && cropRect.viewportAspect > 0
        ? cropRect.viewportAspect
        : Number.isFinite(cropRect?.viewportWidth) &&
            cropRect.viewportWidth > 0 &&
            Number.isFinite(cropRect?.viewportHeight) &&
            cropRect.viewportHeight > 0
          ? cropRect.viewportWidth / cropRect.viewportHeight
          : Number.isFinite(tab.width) &&
              tab.width > 0 &&
              Number.isFinite(tab.height) &&
              tab.height > 0
            ? tab.width / tab.height
            : null;

    let offRes;
    try {
      offRes = await sendToOffscreen('OFFSCREEN_START', {
        sessionId,
        streamId,
        tabId: tab.id,
        mode: resolvedMode,
        format: resolvedFormat,
        keepAudio: resolvedKeepAudio,
        tabTitle: tab.title ?? '',
        incognito: Boolean(tab.incognito),
        cropRect,
        viewportAspect,
        videoQuality: resolvedVideoQuality
      });
    } catch (err) {
      await enterErrorState('OFFSCREEN_LOST', err?.message);
      return { ok: false, errorCode: 'OFFSCREEN_LOST', detail: err?.message };
    }

    if (!offRes?.ok) {
      const errorCode = offRes?.errorCode || 'CAPTURE_FAILED';
      await enterErrorState(errorCode, offRes?.detail);
      await maybeCloseIdleOffscreen();
      return { ok: false, errorCode, detail: offRes?.detail };
    }

    swState.lastExport = null;
    if (prevExportSessionId && prevExportSessionId !== sessionId) {
      await deleteSession(prevExportSessionId).catch(() => {});
    }

    swState.status = RECORDING_STATUS.RECORDING;
    swState.actualFormat = offRes.actualFormat ?? resolvedFormat;
    swState.actualMimeType = offRes.actualMimeType ?? null;
    swState.formatFallback = Boolean(offRes.fallback);
    swState.startedAt = offRes.startedAt ?? Date.now();
    await persistSessionState();
    await applyActionPresentation();
    broadcastStateUpdate();
    startRecordingWatchdog();

    return { ok: true, state: snapshotState() };
  } finally {
    startInFlight = false;
  }
}

async function startRegionSelectionFlow({ tabId, mode, format, keepAudio, videoQuality, pickerMode }) {
  if (
    startInFlight ||
    regionStartInFlight ||
    isBusyRecordingState(swState.status) ||
    swState.status === RECORDING_STATUS.SELECTING_REGION
  ) {
    return { ok: false, errorCode: 'TAB_ALREADY_CAPTURED' };
  }
  regionStartInFlight = true;

  try {
    let tab;
    try {
      tab = await resolveTargetTab(tabId);
    } catch {
      tab = null;
    }

    const urlCheck = isUrlAllowed(tab?.url);
    if (!tab || !urlCheck.allowed) {
      await enterErrorState('UNSUPPORTED_TAB');
      return { ok: false, errorCode: 'UNSUPPORTED_TAB' };
    }
    if (tab.active === false) {
      await enterErrorState('NOT_INVOKED');
      return { ok: false, errorCode: 'NOT_INVOKED' };
    }

    let screenshotDataUrl = '';
    try {
      screenshotDataUrl = await globalThis.chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'png'
      });
    } catch (err) {
      const errorCode = classifyTabCaptureError(err);
      await enterErrorState(errorCode, err?.message);
      return { ok: false, errorCode, detail: err?.message };
    }

    let activeCheckTab = null;
    try {
      activeCheckTab = await resolveTargetTab(tab.id);
    } catch {
      activeCheckTab = null;
    }
    if (
      !activeCheckTab ||
      activeCheckTab.active === false ||
      !isUrlAllowed(activeCheckTab.url).allowed
    ) {
      await enterErrorState('NOT_INVOKED');
      return { ok: false, errorCode: 'NOT_INVOKED' };
    }

    const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
    const resolvedMode = mode ?? settings.mode;
    const resolvedFormat = format ?? settings.formatsByMode[resolvedMode] ?? 'webm';
    const resolvedVideoQuality =
      typeof videoQuality === 'string' &&
      Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, videoQuality)
        ? videoQuality
        : settings.videoQuality ?? DEFAULT_SETTINGS.videoQuality;
    const resolvedKeepAudio =
      typeof keepAudio === 'boolean' ? keepAudio : settings.keepAudio;
    const resolvedPickerMode =
      pickerMode === REGION_PICKER_MODES.MANUAL || pickerMode === REGION_PICKER_MODES.SMART
        ? pickerMode
        : settings.regionPickerMode ?? DEFAULT_SETTINGS.regionPickerMode;
    const selectionToken =
      globalThis.crypto?.randomUUID?.() ??
      `sel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    activeSelectionToken = selectionToken;
    regionSelectionStartedAt = Date.now();
    pendingRegionSelection = {
      tabId: tab.id,
      selectionToken,
      mode: resolvedMode,
      format: resolvedFormat,
      videoQuality: resolvedVideoQuality,
      keepAudio: resolvedKeepAudio,
      pickerMode: resolvedPickerMode,
      showFirstUseHint: !settings.regionSmartHintSeen,
      screenshotDataUrl,
      strings: {
        regionHintDrag: getMessage('regionHintDrag'),
        regionHintSmart: getMessage('regionHintSmart'),
        regionModeSmart: getMessage('regionModeSmart'),
        regionModeManual: getMessage('regionModeManual'),
        regionHelpToggleAria: getMessage('regionHelpToggleAria'),
        regionCoachTitle: getMessage('regionCoachTitle'),
        regionCoachStepHover: getMessage('regionCoachStepHover'),
        regionCoachStepWheel: getMessage('regionCoachStepWheel'),
        regionCoachStepClick: getMessage('regionCoachStepClick'),
        regionCoachGotIt: getMessage('regionCoachGotIt'),
        regionBtnStart: getMessage('regionBtnStart'),
        regionBtnReselect: getMessage('regionBtnReselect'),
        regionBtnCancel: getMessage('regionBtnCancel'),
        regionBtnWider: getMessage('regionBtnWider'),
        regionBtnNarrower: getMessage('regionBtnNarrower'),
        regionBtnWiderTitle: getMessage('regionBtnWiderTitle'),
        regionBtnNarrowerTitle: getMessage('regionBtnNarrowerTitle'),
        regionTooSmall: getMessage('regionTooSmall'),
        regionElVideo: getMessage('regionElVideo'),
        regionElFrame: getMessage('regionElFrame'),
        regionElCanvas: getMessage('regionElCanvas'),
        regionElImage: getMessage('regionElImage'),
        regionElTable: getMessage('regionElTable'),
        regionElCode: getMessage('regionElCode'),
        regionElDialog: getMessage('regionElDialog'),
        regionElArticle: getMessage('regionElArticle'),
        regionElSection: getMessage('regionElSection'),
        regionElBlock: getMessage('regionElBlock')
      },
      limits: {
        MIN_REGION_SIZE_PX: LIMITS.MIN_REGION_SIZE_PX,
        REGION_DEDUPE_TOLERANCE_PX: LIMITS.REGION_DEDUPE_TOLERANCE_PX,
        REGION_DRAG_SWITCH_PX: LIMITS.REGION_DRAG_SWITCH_PX,
        LOUPE_DIAMETER_PX: LIMITS.LOUPE_DIAMETER_PX,
        LOUPE_ZOOM: LIMITS.LOUPE_ZOOM
      }
    };

    swState.status = RECORDING_STATUS.SELECTING_REGION;
    swState.mode = resolvedMode;
    swState.format = resolvedFormat;
    swState.videoQuality = resolvedVideoQuality;
    swState.keepAudio = resolvedKeepAudio;
    swState.regionPickerMode = resolvedPickerMode;
    swState.recordedTabId = tab.id;
    swState.recordedTabTitle = tab.title ?? '';
    swState.errorCode = null;
    swState.errorDetail = null;
    await persistSessionState();
    broadcastStateUpdate();

    clearRegionSelectionTimer();
    regionSelectionTimerId = setTimeout(() => {
      cancelRegionSelection().catch(() => {});
    }, LIMITS.REGION_SELECTION_TIMEOUT_MS);
    regionSelectionTimerId?.unref?.();

    try {
      await globalThis.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (cfg) => {
          globalThis.__WEBTABREC_REGION_CONFIG__ = cfg;
        },
        args: [pendingRegionSelection]
      });
      await globalThis.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/region-selector.js']
      });
    } catch (err) {
      const stillAllowed = isUrlAllowed(activeCheckTab?.url).allowed;
      const errorCode = stillAllowed ? 'INJECTION_FAILED' : 'UNSUPPORTED_TAB';
      await enterErrorState(errorCode, err?.message);
      return { ok: false, errorCode, detail: err?.message };
    }

    return { ok: true };
  } finally {
    regionStartInFlight = false;
  }
}

async function pauseRecordingFlow(sessionId) {
  if (
    swState.status !== RECORDING_STATUS.RECORDING ||
    (sessionId && swState.sessionId !== sessionId)
  ) {
    return { ok: false };
  }
  const targetSessionId = sessionId ?? swState.sessionId;
  let res;
  try {
    res = await sendToOffscreen('PAUSE_RECORDING', {
      sessionId: targetSessionId
    });
  } catch (err) {
    await handleOffscreenLost(targetSessionId, err?.message ?? null);
    return { ok: false, errorCode: 'OFFSCREEN_LOST', detail: err?.message ?? null };
  }
  if (!res) {
    await handleOffscreenLost(targetSessionId);
    return { ok: false, errorCode: 'OFFSCREEN_LOST' };
  }
  if (!res.ok) {
    return { ok: false, errorCode: res.errorCode };
  }
  swState.status = RECORDING_STATUS.PAUSED;
  swState.pauseStartedAt = Date.now();
  await persistSessionState();
  await applyActionPresentation();
  broadcastStateUpdate();
  return { ok: true };
}

async function resumeRecordingFlow(sessionId) {
  if (
    swState.status !== RECORDING_STATUS.PAUSED ||
    (sessionId && swState.sessionId !== sessionId)
  ) {
    return { ok: false };
  }
  const targetSessionId = sessionId ?? swState.sessionId;
  let res;
  try {
    res = await sendToOffscreen('RESUME_RECORDING', {
      sessionId: targetSessionId
    });
  } catch (err) {
    await handleOffscreenLost(targetSessionId, err?.message ?? null);
    return { ok: false, errorCode: 'OFFSCREEN_LOST', detail: err?.message ?? null };
  }
  if (!res) {
    await handleOffscreenLost(targetSessionId);
    return { ok: false, errorCode: 'OFFSCREEN_LOST' };
  }
  if (!res.ok) {
    return { ok: false, errorCode: res.errorCode };
  }
  if (swState.pauseStartedAt != null) {
    swState.pausedMs += Math.max(0, Date.now() - swState.pauseStartedAt);
    swState.pauseStartedAt = null;
  }
  swState.status = RECORDING_STATUS.RECORDING;
  await persistSessionState();
  await applyActionPresentation();
  broadcastStateUpdate();
  return { ok: true };
}

async function stopRecordingFlow(sessionId, reason = 'user_stop') {
  if (
    (swState.status !== RECORDING_STATUS.RECORDING &&
      swState.status !== RECORDING_STATUS.PAUSED) ||
    (sessionId && swState.sessionId !== sessionId)
  ) {
    return { ok: false };
  }
  const targetSessionId = sessionId ?? swState.sessionId;
  stopRecordingWatchdog();
  swState.status = RECORDING_STATUS.SAVING;
  await persistSessionState();
  await applyActionPresentation();
  broadcastStateUpdate();

  try {
    const res = await sendToOffscreen('OFFSCREEN_STOP', {
      sessionId: targetSessionId,
      reason
    });
    if (!res) {
      await handleOffscreenLost(targetSessionId);
      return { ok: false, errorCode: 'OFFSCREEN_LOST' };
    }
    if (res.ok === false && swState.status === RECORDING_STATUS.SAVING) {
      await enterErrorState(res.errorCode ?? 'SAVE_FAILED', res.detail ?? null);
      await maybeCloseIdleOffscreen();
    }
    return res;
  } catch (err) {
    await handleOffscreenLost(targetSessionId, err?.message ?? null);
    return { ok: false, errorCode: 'OFFSCREEN_LOST', detail: err?.message };
  }
}

function isAuthorizedRegionSender(sender, payload, expectedTabId) {
  if (sender?.tab) {
    if (expectedTabId != null && sender.tab.id !== expectedTabId) {
      return false;
    }
    if (sender.frameId !== undefined && sender.frameId !== 0) {
      return false;
    }
    if (payload?.tabId != null && payload.tabId !== sender.tab.id) {
      return false;
    }
    if (activeSelectionToken && payload?.selectionToken !== activeSelectionToken) {
      return false;
    }
    return true;
  }
  if (
    payload?.tabId != null &&
    expectedTabId != null &&
    payload.tabId !== expectedTabId
  ) {
    return false;
  }
  return true;
}

function sanitizeCropRect(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const xRatio = Number(raw.xRatio);
  const yRatio = Number(raw.yRatio);
  const wRatio = Number(raw.wRatio);
  const hRatio = Number(raw.hRatio);
  if (
    !Number.isFinite(xRatio) ||
    !Number.isFinite(yRatio) ||
    !Number.isFinite(wRatio) ||
    !Number.isFinite(hRatio) ||
    wRatio <= 0 ||
    hRatio <= 0
  ) {
    return null;
  }
  const clean = {
    xRatio: Math.min(1, Math.max(0, xRatio)),
    yRatio: Math.min(1, Math.max(0, yRatio)),
    wRatio: Math.min(1, Math.max(0, wRatio)),
    hRatio: Math.min(1, Math.max(0, hRatio))
  };
  for (const key of [
    'cssWidth',
    'cssHeight',
    'viewportWidth',
    'viewportHeight',
    'viewportAspect',
    'surfaceWidth',
    'surfaceHeight',
    'pixelWidth',
    'pixelHeight'
  ]) {
    const val = Number(raw[key]);
    if (Number.isFinite(val) && val > 0) {
      clean[key] = val;
    }
  }
  return clean;
}

async function processBackgroundMessage(message, sender) {
  await ensureInitialized();
  const { type, payload } = message;

  const regionTypes = new Set([
    'GET_REGION_SELECTION_CONFIG',
    'REGION_SELECTED',
    'REGION_CANCELLED',
    'REGION_HINT_DISMISSED',
    'REGION_PICKER_MODE_CHANGED'
  ]);
  if (sender?.tab && !regionTypes.has(type)) {
    return { ok: false, errorCode: 'CAPTURE_FAILED' };
  }

  switch (type) {
    case 'GET_STATE': {
      if (
        swState.status === RECORDING_STATUS.SELECTING_REGION &&
        Number.isFinite(regionSelectionStartedAt) &&
        Date.now() - regionSelectionStartedAt >= LIMITS.REGION_SELECTION_TIMEOUT_MS
      ) {
        await cancelRegionSelection();
      }
      if (
        swState.status === RECORDING_STATUS.RECORDING ||
        swState.status === RECORDING_STATUS.PAUSED
      ) {
        if (!(await hasOffscreenDocument())) {
          await handleOffscreenLost(swState.sessionId);
        }
      }
      if (
        swState.status === RECORDING_STATUS.ERROR &&
        swState.errorCode === 'OFFSCREEN_LOST'
      ) {
        const { recoverable, pendingUpdates } = await reconcileIdbSessions();
        await Promise.all(pendingUpdates);
        if (recoverable.length > 0) {
          resetStateToIdle();
          swState.status = RECORDING_STATUS.RECOVERY;
          swState.recoverableSession = recoverable[0];
          await Promise.all([persistSessionState(), applyActionPresentation()]);
        }
      }
      return snapshotState();
    }

    case 'START_REGION_SELECTION':
      return startRegionSelectionFlow(payload ?? {});

    case 'GET_REGION_SELECTION_CONFIG':
      if (
        pendingRegionSelection &&
        (!sender?.tab ||
          (pendingRegionSelection.tabId === sender.tab.id &&
            (sender.frameId === undefined || sender.frameId === 0)))
      ) {
        return pendingRegionSelection;
      }
      return null;

    case 'REGION_SELECTED': {
      if (swState.status !== RECORDING_STATUS.SELECTING_REGION) {
        return { ok: false };
      }
      const pending = pendingRegionSelection;
      const expectedTabId = pending?.tabId ?? swState.recordedTabId;
      if (!isAuthorizedRegionSender(sender, payload, expectedTabId)) {
        return { ok: false };
      }
      const cleanCropRect = sanitizeCropRect(payload?.cropRect);
      if (!cleanCropRect) {
        return { ok: false, errorCode: 'CAPTURE_FAILED' };
      }
      clearRegionSelectionTimer();
      const selectedParams = {
        tabId: sender?.tab?.id ?? expectedTabId,
        mode: pending?.mode ?? swState.mode,
        format: pending?.format ?? swState.format,
        videoQuality: pending?.videoQuality ?? swState.videoQuality,
        keepAudio:
          typeof pending?.keepAudio === 'boolean'
            ? pending.keepAudio
            : swState.keepAudio,
        cropRect: cleanCropRect
      };
      pendingRegionSelection = null;
      activeSelectionToken = null;
      regionSelectionStartedAt = null;
      swState.regionPickerMode = null;
      swState.status = RECORDING_STATUS.IDLE;
      return startRecordingFlow(selectedParams);
    }

    case 'REGION_CANCELLED': {
      if (swState.status !== RECORDING_STATUS.SELECTING_REGION) {
        return { ok: false };
      }
      const expectedTabId = pendingRegionSelection?.tabId ?? swState.recordedTabId;
      if (!isAuthorizedRegionSender(sender, payload, expectedTabId)) {
        return { ok: false };
      }
      await cancelRegionSelection({ removeOverlay: !sender?.tab });
      return { ok: true };
    }

    case 'REGION_HINT_DISMISSED': {
      if (swState.status !== RECORDING_STATUS.SELECTING_REGION) {
        return { ok: false };
      }
      const expectedTabId = pendingRegionSelection?.tabId ?? swState.recordedTabId;
      if (!isAuthorizedRegionSender(sender, payload, expectedTabId)) {
        return { ok: false };
      }
      if (pendingRegionSelection) {
        pendingRegionSelection.showFirstUseHint = false;
      }
      await saveSettings({ regionSmartHintSeen: true }).catch(() => {});
      return { ok: true };
    }

    case 'REGION_PICKER_MODE_CHANGED': {
      if (swState.status !== RECORDING_STATUS.SELECTING_REGION) {
        return { ok: false };
      }
      const expectedTabId = pendingRegionSelection?.tabId ?? swState.recordedTabId;
      if (!isAuthorizedRegionSender(sender, payload, expectedTabId)) {
        return { ok: false };
      }
      const nextMode = payload?.pickerMode;
      if (
        nextMode !== REGION_PICKER_MODES.SMART &&
        nextMode !== REGION_PICKER_MODES.MANUAL
      ) {
        return { ok: false };
      }
      if (pendingRegionSelection) {
        pendingRegionSelection.pickerMode = nextMode;
      }
      swState.regionPickerMode = nextMode;
      await Promise.all([
        saveSettings({ regionPickerMode: nextMode }).catch(() => {}),
        persistSessionState().catch(() => {})
      ]);
      broadcastStateUpdate();
      return { ok: true };
    }

    case 'START_RECORDING': {
      const startPayload = payload && typeof payload === 'object' ? { ...payload } : {};
      if ('cropRect' in startPayload && startPayload.cropRect != null) {
        const cleanCrop = sanitizeCropRect(startPayload.cropRect);
        if (!cleanCrop) {
          return { ok: false, errorCode: 'CAPTURE_FAILED' };
        }
        startPayload.cropRect = cleanCrop;
      } else {
        startPayload.cropRect = null;
      }
      return startRecordingFlow(startPayload);
    }

    case 'PAUSE_RECORDING':
      return pauseRecordingFlow(payload?.sessionId);

    case 'RESUME_RECORDING':
      return resumeRecordingFlow(payload?.sessionId);

    case 'SET_KEEP_AUDIO': {
      const nextKeep = Boolean(payload?.keepAudio);
      if (!(await hasOffscreenDocument())) {
        return { ok: false, errorCode: 'OFFSCREEN_LOST' };
      }
      let offRes;
      try {
        offRes = await sendToOffscreen('SET_KEEP_AUDIO', {
          sessionId: payload?.sessionId ?? swState.sessionId,
          keepAudio: nextKeep
        });
      } catch (err) {
        return { ok: false, errorCode: 'OFFSCREEN_LOST', detail: err?.message };
      }
      if (!offRes?.ok) {
        return { ok: false, errorCode: offRes?.errorCode ?? 'CAPTURE_FAILED' };
      }
      swState.keepAudio = nextKeep;
      await persistSessionState();
      broadcastStateUpdate();
      return { ok: true, keepAudio: nextKeep };
    }

    case 'STOP_RECORDING':
      return stopRecordingFlow(payload?.sessionId, payload?.reason ?? 'user_stop');

    case 'RECORDING_STARTED': {
      if (payload?.sessionId && swState.sessionId === payload.sessionId) {
        swState.status = RECORDING_STATUS.RECORDING;
        swState.actualFormat = payload.actualFormat ?? swState.actualFormat;
        swState.actualMimeType = payload.actualMimeType ?? swState.actualMimeType;
        swState.formatFallback = Boolean(payload.fallback);
        swState.startedAt = payload.startedAt ?? swState.startedAt;
        await persistSessionState();
        await applyActionPresentation();
        broadcastStateUpdate();
        startRecordingWatchdog();
      }
      return { ok: true };
    }

    case 'OFFSCREEN_TICK': {
      if (payload?.sessionId && swState.sessionId === payload.sessionId) {
        swState.durationMs = payload.durationMs ?? swState.durationMs;
        swState.bytesRecorded = payload.bytesRecorded ?? swState.bytesRecorded;
        broadcastStateUpdate();
      }
      return { ok: true };
    }

    case 'RECORDING_EXPORTED': {
      if (
        swState.status === RECORDING_STATUS.ERROR &&
        swState.errorCode !== 'OFFSCREEN_LOST'
      ) {
        return { ok: true };
      }
      if (
        swState.sessionId &&
        payload?.sessionId &&
        swState.sessionId !== payload.sessionId
      ) {
        return { ok: true };
      }
      const notice =
        swState.noticeCode ??
        (payload?.reason === 'tab_closed'
          ? 'TAB_CLOSED_SAVED'
          : payload?.reason === 'wav_size_limit'
            ? 'WAV_SIZE_LIMIT'
            : payload?.reason === 'quota_exceeded'
              ? 'STORAGE_QUOTA_EXCEEDED'
              : null);

      const canKeepExport = !payload?.incognito && payload?.canExportAgain !== false;
      const lastExport = !canKeepExport
        ? null
        : {
            sessionId: payload?.sessionId,
            filename: payload?.filename,
            bytes: payload?.bytes,
            durationMs: payload?.durationMs,
            reason: payload?.reason,
            actualFormat: payload?.actualFormat
          };

      resetStateToIdle();
      swState.status = !canKeepExport
        ? RECORDING_STATUS.IDLE
        : RECORDING_STATUS.COMPLETED;
      swState.lastExport = lastExport;
      swState.noticeCode = notice;
      await persistSessionState();
      await applyActionPresentation();
      broadcastStateUpdate();
      return { ok: true };
    }

    case 'RECORDING_ERROR': {
      if (
        payload?.sessionId &&
        swState.sessionId &&
        swState.sessionId !== payload.sessionId
      ) {
        return { ok: true };
      }
      const code = payload?.errorCode ?? 'CAPTURE_FAILED';
      if (
        !payload?.terminal &&
        (code === 'WAV_SIZE_LIMIT' || code === 'STORAGE_QUOTA_EXCEEDED')
      ) {
        swState.noticeCode = code;
        swState.errorCode = code;
        swState.errorDetail = payload?.detail ?? null;
        broadcastStateUpdate();
        return { ok: true };
      }
      if (payload?.hasRecoverableData && payload?.sessionId) {
        const idbRecoverable = await getSession(payload.sessionId).catch(() => null);
        swState.recoverableSession = idbRecoverable ?? {
          sessionId: payload.sessionId,
          mode: swState.mode,
          format: swState.actualFormat ?? swState.format,
          tabTitle: swState.recordedTabTitle,
          bytesRecorded: swState.bytesRecorded,
          durationMs: swState.durationMs
        };
      }
      await enterErrorState(code, payload?.detail ?? null);
      await maybeCloseIdleOffscreen();
      return { ok: true };
    }

    case 'EXPORT_AGAIN': {
      const sessionId = payload?.sessionId ?? swState.lastExport?.sessionId;
      if (!sessionId) {
        return { ok: false, errorCode: 'SAVE_FAILED' };
      }
      let res;
      try {
        await ensureOffscreenDocument(
          getOffscreenReasonsForMode(swState.mode, 'export'),
          'Re-assemble and export recorded media blob locally'
        );
        res = await sendToOffscreen('EXPORT_AGAIN', { sessionId });
      } catch (err) {
        res = {
          ok: false,
          errorCode: 'SAVE_FAILED',
          detail: err?.message ?? String(err)
        };
      }
      if (!res?.ok) {
        const errorCode =
          res?.errorCode === 'RECOVERY_FAILED' ? 'RECOVERY_FAILED' : 'SAVE_FAILED';
        await enterErrorState(errorCode, res?.detail ?? null);
        await maybeCloseIdleOffscreen();
        return { ok: false, errorCode, detail: res?.detail ?? null };
      }
      return res;
    }

    case 'DISMISS_EXPORT': {
      const sessionId = payload?.sessionId ?? swState.lastExport?.sessionId;
      if (sessionId) {
        if (await hasOffscreenDocument()) {
          await sendToOffscreen('DISMISS_EXPORT', { sessionId }).catch(() => {});
        }
        await deleteSession(sessionId).catch(() => {});
      }
      resetStateToIdle();
      await persistSessionState();
      await applyActionPresentation();
      broadcastStateUpdate();
      await maybeCloseIdleOffscreen();
      return { ok: true };
    }

    case 'RECOVER_SESSION': {
      const sessionId = payload?.sessionId ?? swState.recoverableSession?.sessionId;
      if (!sessionId) {
        return { ok: false, errorCode: 'RECOVERY_FAILED' };
      }
      const prevRecoverable = swState.recoverableSession;
      swState.status = RECORDING_STATUS.SAVING;
      swState.recoverableSession = null;
      await persistSessionState();
      broadcastStateUpdate();

      let res;
      try {
        await ensureOffscreenDocument(
          getOffscreenReasonsForMode('audio', 'recovery'),
          'Recover interrupted recording chunks into a downloadable local file'
        );
        res = await sendToOffscreen('RECOVER_SESSION', { sessionId });
      } catch (err) {
        res = {
          ok: false,
          errorCode: err?.errorCode ?? 'RECOVERY_FAILED',
          detail: err?.message ?? String(err)
        };
      }
      if (!res?.ok) {
        swState.recoverableSession = prevRecoverable ?? { sessionId };
        await enterErrorState(res?.errorCode ?? 'RECOVERY_FAILED', res?.detail);
      }
      return res;
    }

    case 'DISCARD_SESSION': {
      const sessionId = payload?.sessionId ?? swState.recoverableSession?.sessionId;
      if (sessionId) {
        if (await hasOffscreenDocument()) {
          await sendToOffscreen('DISCARD_SESSION', { sessionId }).catch(() => {});
        }
        await deleteSession(sessionId).catch(() => {});
      }
      resetStateToIdle();
      await persistSessionState();
      await applyActionPresentation();
      broadcastStateUpdate();
      await maybeCloseIdleOffscreen();
      return { ok: true };
    }

    case 'DISMISS_ERROR': {
      // Never delete persisted sessions on Dismiss — return to COMPLETED or RECOVERY if data exists.
      // Explicit deletion happens strictly through DISCARD_SESSION / DISMISS_EXPORT.
      if (swState.errorCode === 'SAVE_FAILED' && swState.lastExport?.sessionId) {
        const preservedExport = swState.lastExport;
        resetStateToIdle();
        swState.status = RECORDING_STATUS.COMPLETED;
        swState.lastExport = preservedExport;
      } else if (swState.recoverableSession?.sessionId) {
        const preservedRecoverable = swState.recoverableSession;
        const stillInIdb = await getSession(preservedRecoverable.sessionId).catch(() => null);
        resetStateToIdle();
        if (stillInIdb) {
          swState.status = RECORDING_STATUS.RECOVERY;
          swState.recoverableSession = stillInIdb;
        }
      } else {
        resetStateToIdle();
      }
      await persistSessionState();
      await applyActionPresentation();
      broadcastStateUpdate();
      await maybeCloseIdleOffscreen();
      return { ok: true };
    }

    case 'EXPORT_HANDOFF_EXPIRED':
      if ((payload?.pendingExportsCount ?? 0) === 0) {
        await maybeCloseIdleOffscreen();
      }
      return { ok: true };

    case 'OFFSCREEN_IDLE':
      await maybeCloseIdleOffscreen();
      return { ok: true };

    default:
      return { ok: false, error: `Unknown background message type: ${type}` };
  }
}

function handleRuntimeMessage(message, sender, sendResponse) {
  if (!message || message.target !== 'background') {
    return false;
  }
  processBackgroundMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      sendResponse({
        ok: false,
        errorCode: err?.errorCode ?? 'CAPTURE_FAILED',
        detail: err?.message ?? String(err)
      });
    });
  return true;
}

if (globalThis.chrome?.runtime?.onMessage) {
  globalThis.chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

if (globalThis.chrome?.runtime?.onInstalled) {
  globalThis.chrome.runtime.onInstalled.addListener((details) => {
    if (details?.reason === 'install') {
      const url = globalThis.chrome.runtime.getURL?.(WELCOME_URL) ?? WELCOME_URL;
      globalThis.chrome.tabs?.create?.({ url })?.catch?.(() => {});
    }
  });
}

if (globalThis.chrome?.runtime?.onStartup) {
  globalThis.chrome.runtime.onStartup.addListener(() => {
    const prev = initPromise ?? Promise.resolve();
    initPromise = prev
      .catch(() => {})
      .then(() => runInitialization())
      .catch((err) => {
        console.error('WebTabRec startup reconciliation failed:', err);
        initPromise = null;
      });
  });
}

if (globalThis.chrome?.tabs?.onRemoved) {
  globalThis.chrome.tabs.onRemoved.addListener((tabId) => {
    ensureInitialized()
      .then(() => {
        if (
          swState.status === RECORDING_STATUS.SELECTING_REGION &&
          swState.recordedTabId === tabId
        ) {
          return cancelRegionSelection({ removeOverlay: false });
        }
        return undefined;
      })
      .catch(() => {});
  });
}

if (globalThis.chrome?.tabs?.onUpdated) {
  globalThis.chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    ensureInitialized()
      .then(() => {
        if (
          swState.status === RECORDING_STATUS.SELECTING_REGION &&
          swState.recordedTabId === tabId &&
          (changeInfo?.status === 'loading' || changeInfo?.url !== undefined)
        ) {
          return cancelRegionSelection();
        }
        return undefined;
      })
      .catch(() => {});
  });
}

if (globalThis.chrome?.tabs?.onActivated) {
  globalThis.chrome.tabs.onActivated.addListener((activeInfo) => {
    ensureInitialized()
      .then(() => {
        if (
          swState.status === RECORDING_STATUS.SELECTING_REGION &&
          swState.recordedTabId != null &&
          activeInfo?.tabId !== swState.recordedTabId
        ) {
          return cancelRegionSelection();
        }
        return undefined;
      })
      .catch(() => {});
  });
}

if (globalThis.chrome?.commands?.onCommand) {
  globalThis.chrome.commands.onCommand.addListener(async (command, tab) => {
    await ensureInitialized();
    if (command === 'toggle-recording') {
      if (
        swState.status === RECORDING_STATUS.RECORDING ||
        swState.status === RECORDING_STATUS.PAUSED
      ) {
        await stopRecordingFlow(swState.sessionId, 'user_stop');
      } else if (
        !isBusyRecordingState(swState.status) &&
        swState.status !== RECORDING_STATUS.SELECTING_REGION
      ) {
        const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
        const mode = settings.mode;
        const format = settings.formatsByMode?.[mode] ?? 'webm';
        await startRecordingFlow({
          tabId: tab?.id,
          mode,
          format,
          keepAudio: settings.keepAudio
        });
      }
    } else if (command === 'toggle-pause') {
      if (swState.status === RECORDING_STATUS.RECORDING) {
        await pauseRecordingFlow(swState.sessionId);
      } else if (swState.status === RECORDING_STATUS.PAUSED) {
        await resumeRecordingFlow(swState.sessionId);
      }
    }
  });
}

if (globalThis.chrome?.storage?.onChanged) {
  globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes?.[SETTINGS_KEY]) {
      refreshI18n()
        .then(() => applyActionPresentation())
        .catch(() => {});
    }
  });
}

ensureInitialized();
