#!/usr/bin/env node
/**
 * Pure-Node.js Chrome Web Store API v2 publisher (zero external dependencies).
 *
 * Authenticates with a Google Cloud Service Account JSON key (RS256 JWT -> OAuth2 Bearer),
 * uploads a packaged release ZIP to Chrome Web Store API v2, polls `:fetchStatus` when
 * asynchronous processing is in progress, and optionally submits the revision via `:publish`.
 *
 * Required environment variables for CLI execution:
 *   CHROME_PUBLISHER_ID          — Chrome Web Store Publisher ID (from Developer Dashboard -> Account)
 *   CHROME_EXTENSION_ID          — Chrome Web Store Item / Extension ID (32 lowercase letters a-p)
 *   CHROME_SERVICE_ACCOUNT_JSON  — Raw JSON string of Google Cloud Service Account key
 *
 * Optional environment variables:
 *   CWS_ZIP_PATH                 — Path to ZIP file (default: dist/webtabrec-v<manifest.version>.zip)
 *   CWS_PUBLISH_MODE             — 'draft' (upload only, default) | 'staged' (STAGED_PUBLISH) | 'publish' (DEFAULT_PUBLISH)
 *   CWS_DEPLOY_PERCENTAGE        — Rollout percentage 1..100 (default: 100)
 *   CWS_SKIP_REVIEW              — 'true' | 'false' (default: 'false')
 *   CWS_DRY_RUN                  — 'true' to validate inputs & ZIP without network calls
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const CWS_UPLOAD_BASE = 'https://chromewebstore.googleapis.com/upload/v2';
export const CWS_API_BASE = 'https://chromewebstore.googleapis.com/v2';

const VALID_PUBLISHER_ID_RE = /^[A-Za-z0-9_-]{3,128}$/;
const VALID_EXTENSION_ID_RE = /^[a-p]{32}$/;
const VALID_MODES = new Set(['draft', 'staged', 'publish']);

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Validates publisherId, extensionId, mode, deployPercentage, and service account payload.
 * Throws descriptive errors without echoing secret private key material.
 */
export function validatePublishConfig({
  publisherId,
  extensionId,
  serviceAccount,
  mode = 'draft',
  deployPercentage = 100
}) {
  if (typeof publisherId !== 'string' || !VALID_PUBLISHER_ID_RE.test(publisherId.trim())) {
    throw new Error('Invalid CHROME_PUBLISHER_ID: expected 3-128 alphanumeric/dash/underscore characters.');
  }
  if (typeof extensionId !== 'string' || !VALID_EXTENSION_ID_RE.test(extensionId.trim())) {
    throw new Error('Invalid CHROME_EXTENSION_ID: expected 32 lowercase characters in range a-p.');
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid CWS_PUBLISH_MODE "${mode}": expected one of draft, staged, publish.`);
  }
  const pct = Number(deployPercentage);
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
    throw new Error(`Invalid CWS_DEPLOY_PERCENTAGE "${deployPercentage}": expected integer 1..100.`);
  }
  if (!serviceAccount || typeof serviceAccount !== 'object') {
    throw new Error('Missing or invalid CHROME_SERVICE_ACCOUNT_JSON object.');
  }
  if (typeof serviceAccount.client_email !== 'string' || !serviceAccount.client_email.includes('@')) {
    throw new Error('Service account JSON missing valid client_email.');
  }
  if (
    typeof serviceAccount.private_key !== 'string' ||
    !serviceAccount.private_key.includes('BEGIN PRIVATE KEY')
  ) {
    throw new Error('Service account JSON missing valid PEM private_key.');
  }
  const tokenUri =
    typeof serviceAccount.token_uri === 'string' && serviceAccount.token_uri.startsWith('https://')
      ? serviceAccount.token_uri
      : DEFAULT_TOKEN_URI;

  return {
    publisherId: publisherId.trim(),
    extensionId: extensionId.trim(),
    mode,
    deployPercentage: pct,
    tokenUri,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key
  };
}

/**
 * Creates an RS256-signed JWT assertion for Google OAuth2 Service Account token exchange.
 */
export function createServiceAccountJwt(
  serviceAccount,
  { scope = CWS_SCOPE, nowSec = Math.floor(Date.now() / 1000) } = {}
) {
  const tokenUri =
    typeof serviceAccount.token_uri === 'string' && serviceAccount.token_uri.startsWith('https://')
      ? serviceAccount.token_uri
      : DEFAULT_TOKEN_URI;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/**
 * Exchanges a signed Service Account JWT for a short-lived OAuth2 Bearer access token.
 */
export async function exchangeJwtForAccessToken(
  jwt,
  { tokenUri = DEFAULT_TOKEN_URI, fetchImpl = globalThis.fetch } = {}
) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });
  const res = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await parseJsonSafe(res);
  if (!res.ok || typeof data.access_token !== 'string' || !data.access_token) {
    const reason = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`OAuth2 token exchange failed: ${reason}`);
  }
  return data.access_token;
}

/**
 * Uploads a ZIP package buffer to Chrome Web Store API v2 `:upload`.
 */
export async function uploadCwsPackage({
  publisherId,
  extensionId,
  zipBuffer,
  accessToken,
  fetchImpl = globalThis.fetch
}) {
  const url = `${CWS_UPLOAD_BASE}/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:upload`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip'
    },
    body: zipBuffer
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const reason = data?.error?.message || data?.raw || `HTTP ${res.status}`;
    throw new Error(`CWS upload failed (${res.status}): ${reason}`);
  }
  return data;
}

/**
 * Polls Chrome Web Store API v2 `:fetchStatus` while `lastAsyncUploadState === 'IN_PROGRESS'`.
 */
export async function pollCwsUploadStatus({
  publisherId,
  extensionId,
  accessToken,
  fetchImpl = globalThis.fetch,
  maxAttempts = 20,
  delayMs = 3000,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  const url = `${CWS_API_BASE}/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:fetchStatus`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      const reason = data?.error?.message || data?.raw || `HTTP ${res.status}`;
      throw new Error(`CWS fetchStatus failed (${res.status}): ${reason}`);
    }
    const state = data.lastAsyncUploadState || data.uploadState;
    if (state === 'SUCCEEDED') {
      return data;
    }
    if (state === 'FAILED' || state === 'NOT_FOUND') {
      throw new Error(`CWS async upload finished with state ${state}: ${JSON.stringify(data)}`);
    }
    if (attempt < maxAttempts) {
      await sleepImpl(delayMs);
    }
  }
  throw new Error(`CWS async upload did not finish after ${maxAttempts} status checks.`);
}

/**
 * Submits the uploaded revision via Chrome Web Store API v2 `:publish`.
 */
export async function publishCwsItem({
  publisherId,
  extensionId,
  accessToken,
  publishType = 'DEFAULT_PUBLISH',
  deployPercentage = 100,
  skipReview = false,
  fetchImpl = globalThis.fetch
}) {
  const url = `${CWS_API_BASE}/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:publish`;
  const payload = {
    publishType,
    deployInfos: [{ deployPercentage }],
    skipReview: Boolean(skipReview)
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    const reason = data?.error?.message || data?.raw || `HTTP ${res.status}`;
    throw new Error(`CWS publish failed (${res.status}): ${reason}`);
  }
  return data;
}

/**
 * Full end-to-end Chrome Web Store API v2 upload & optional publish flow.
 */
export async function publishToChromeWebStore({
  publisherId,
  extensionId,
  serviceAccount,
  zipPath,
  mode = 'draft',
  deployPercentage = 100,
  skipReview = false,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  sleepImpl,
  pollDelayMs = 3000,
  pollMaxAttempts = 20
}) {
  const cfg = validatePublishConfig({
    publisherId,
    extensionId,
    serviceAccount,
    mode,
    deployPercentage
  });

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Release ZIP not found: ${zipPath}`);
  }
  const zipBuffer = fs.readFileSync(zipPath);
  if (zipBuffer.length < 22 || zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
    throw new Error(`File does not appear to be a valid ZIP archive: ${zipPath}`);
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode: cfg.mode,
      zipBytes: zipBuffer.length,
      publisherId: cfg.publisherId,
      extensionId: cfg.extensionId
    };
  }

  const jwt = createServiceAccountJwt(serviceAccount);
  const accessToken = await exchangeJwtForAccessToken(jwt, {
    tokenUri: cfg.tokenUri,
    fetchImpl
  });

  const uploadResult = await uploadCwsPackage({
    publisherId: cfg.publisherId,
    extensionId: cfg.extensionId,
    zipBuffer,
    accessToken,
    fetchImpl
  });

  let finalUploadState = uploadResult.uploadState || 'SUCCEEDED';
  if (finalUploadState === 'IN_PROGRESS') {
    const status = await pollCwsUploadStatus({
      publisherId: cfg.publisherId,
      extensionId: cfg.extensionId,
      accessToken,
      fetchImpl,
      delayMs: pollDelayMs,
      maxAttempts: pollMaxAttempts,
      sleepImpl
    });
    finalUploadState = status.lastAsyncUploadState || status.uploadState || 'SUCCEEDED';
  } else if (finalUploadState !== 'SUCCEEDED') {
    throw new Error(`Unexpected CWS uploadState "${finalUploadState}": ${JSON.stringify(uploadResult)}`);
  }

  let publishResult = null;
  if (cfg.mode === 'staged' || cfg.mode === 'publish') {
    publishResult = await publishCwsItem({
      publisherId: cfg.publisherId,
      extensionId: cfg.extensionId,
      accessToken,
      publishType: cfg.mode === 'staged' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH',
      deployPercentage: cfg.deployPercentage,
      skipReview,
      fetchImpl
    });
  }

  return {
    ok: true,
    dryRun: false,
    mode: cfg.mode,
    zipBytes: zipBuffer.length,
    uploadState: finalUploadState,
    crxVersion: uploadResult.crxVersion ?? null,
    publishState: publishResult?.state ?? null
  };
}

function resolveDefaultZipPath(rootDir) {
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return path.join(rootDir, 'dist', `webtabrec-v${manifest.version}.zip`);
}

async function runCli() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const publisherId = process.env.CHROME_PUBLISHER_ID || '';
  const extensionId = process.env.CHROME_EXTENSION_ID || '';
  const rawSa = process.env.CHROME_SERVICE_ACCOUNT_JSON || '';
  const mode = (process.env.CWS_PUBLISH_MODE || 'draft').trim().toLowerCase();
  const deployPercentage = Number(process.env.CWS_DEPLOY_PERCENTAGE || '100');
  const skipReview = process.env.CWS_SKIP_REVIEW === 'true';
  const dryRun = process.env.CWS_DRY_RUN === 'true';
  const zipPath = process.env.CWS_ZIP_PATH || resolveDefaultZipPath(rootDir);

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawSa);
  } catch {
    throw new Error('CHROME_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  const res = await publishToChromeWebStore({
    publisherId,
    extensionId,
    serviceAccount,
    zipPath,
    mode,
    deployPercentage,
    skipReview,
    dryRun
  });

  console.log(
    `OK: Chrome Web Store (${res.mode}${res.dryRun ? ', dry-run' : ''}) — ZIP ${res.zipBytes} bytes` +
      (res.crxVersion ? `, version ${res.crxVersion}` : '') +
      (res.uploadState ? `, uploadState=${res.uploadState}` : '') +
      (res.publishState ? `, publishState=${res.publishState}` : '')
  );
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runCli().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  });
}
