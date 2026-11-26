import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CWS_SCOPE,
  DEFAULT_TOKEN_URI,
  validatePublishConfig,
  createServiceAccountJwt,
  exchangeJwtForAccessToken,
  publishToChromeWebStore
} from '../../scripts/publish-cws.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const SAMPLE_SA = {
  client_email: 'webtabrec-cws@example-project.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: DEFAULT_TOKEN_URI
};

const VALID_EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const VALID_PUB_ID = 'pub-1234567890';

async function withTempZip(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtabrec-cws-test-'));
  const zipPath = path.join(dir, 'webtabrec-v1.0.0.zip');
  // Minimal ZIP header (PK\x03\x04 + padding >= 22 bytes)
  const buf = Buffer.alloc(32, 0);
  buf[0] = 0x50;
  buf[1] = 0x4b;
  buf[2] = 0x03;
  buf[3] = 0x04;
  fs.writeFileSync(zipPath, buf);
  try {
    return await fn(zipPath, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('createServiceAccountJwt signs a verifiable RS256 JWT with CWS scope', () => {
  const jwt = createServiceAccountJwt(SAMPLE_SA, { nowSec: 1_700_000_000 });
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.iss, SAMPLE_SA.client_email);
  assert.equal(payload.scope, CWS_SCOPE);
  assert.equal(payload.aud, DEFAULT_TOKEN_URI);
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_003_600);

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(parts[2], 'base64url')), true);
});

test('validatePublishConfig rejects invalid IDs, modes, rollout percentage, and malformed keys', () => {
  assert.throws(
    () =>
      validatePublishConfig({
        publisherId: '../evil',
        extensionId: VALID_EXT_ID,
        serviceAccount: SAMPLE_SA
      }),
    /CHROME_PUBLISHER_ID/
  );
  assert.throws(
    () =>
      validatePublishConfig({
        publisherId: VALID_PUB_ID,
        extensionId: 'not-a-valid-extension-id',
        serviceAccount: SAMPLE_SA
      }),
    /CHROME_EXTENSION_ID/
  );
  assert.throws(
    () =>
      validatePublishConfig({
        publisherId: VALID_PUB_ID,
        extensionId: VALID_EXT_ID,
        serviceAccount: SAMPLE_SA,
        mode: 'invalid'
      }),
    /CWS_PUBLISH_MODE/
  );
  assert.throws(
    () =>
      validatePublishConfig({
        publisherId: VALID_PUB_ID,
        extensionId: VALID_EXT_ID,
        serviceAccount: SAMPLE_SA,
        deployPercentage: 150
      }),
    /CWS_DEPLOY_PERCENTAGE/
  );
  assert.throws(
    () =>
      validatePublishConfig({
        publisherId: VALID_PUB_ID,
        extensionId: VALID_EXT_ID,
        serviceAccount: { client_email: 'sa@example.com', private_key: 'bad' }
      }),
    /private_key/
  );
});

test('publishToChromeWebStore handles draft upload (no :publish call) and async IN_PROGRESS polling', async () => {
  await withTempZip(async (zipPath) => {
    const calls = [];
    let statusChecks = 0;
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (url === DEFAULT_TOKEN_URI) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token' }), { status: 200 });
      }
      if (url.endsWith(':upload')) {
        return new Response(JSON.stringify({ uploadState: 'IN_PROGRESS', crxVersion: '1.0.1' }), { status: 200 });
      }
      if (url.endsWith(':fetchStatus')) {
        statusChecks += 1;
        return new Response(
          JSON.stringify({ lastAsyncUploadState: statusChecks >= 2 ? 'SUCCEEDED' : 'IN_PROGRESS' }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const res = await publishToChromeWebStore({
      publisherId: VALID_PUB_ID,
      extensionId: VALID_EXT_ID,
      serviceAccount: SAMPLE_SA,
      zipPath,
      mode: 'draft',
      fetchImpl,
      sleepImpl: async () => {}
    });

    assert.equal(res.ok, true);
    assert.equal(res.mode, 'draft');
    assert.equal(res.uploadState, 'SUCCEEDED');
    assert.equal(res.crxVersion, '1.0.1');
    assert.equal(res.publishState, null);
    assert.equal(statusChecks, 2);
    assert.equal(calls.some((c) => c.url.endsWith(':publish')), false);
  });
});

test('publishToChromeWebStore submits DEFAULT_PUBLISH and STAGED_PUBLISH payloads accurately', async () => {
  await withTempZip(async (zipPath) => {
    for (const [mode, expectedType] of [
      ['publish', 'DEFAULT_PUBLISH'],
      ['staged', 'STAGED_PUBLISH']
    ]) {
      let publishPayload = null;
      const fetchImpl = async (url, init) => {
        if (url === DEFAULT_TOKEN_URI) {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }
        if (url.endsWith(':upload')) {
          return new Response(JSON.stringify({ uploadState: 'SUCCEEDED', crxVersion: '1.0.2' }), { status: 200 });
        }
        if (url.endsWith(':publish')) {
          publishPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({ state: 'PENDING_REVIEW' }), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const res = await publishToChromeWebStore({
        publisherId: VALID_PUB_ID,
        extensionId: VALID_EXT_ID,
        serviceAccount: SAMPLE_SA,
        zipPath,
        mode,
        deployPercentage: 25,
        fetchImpl
      });

      assert.equal(res.publishState, 'PENDING_REVIEW');
      assert.deepEqual(publishPayload, {
        publishType: expectedType,
        deployInfos: [{ deployPercentage: 25 }],
        skipReview: false
      });
    }
  });
});

test('publishToChromeWebStore dryRun validates ZIP without network calls and exchangeJwtForAccessToken surfaces clean errors', async () => {
  await withTempZip(async (zipPath) => {
    let fetchCalled = false;
    const res = await publishToChromeWebStore({
      publisherId: VALID_PUB_ID,
      extensionId: VALID_EXT_ID,
      serviceAccount: SAMPLE_SA,
      zipPath,
      mode: 'publish',
      dryRun: true,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error('Should not be called');
      }
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(fetchCalled, false);
  });

  await assert.rejects(
    () =>
      exchangeJwtForAccessToken('bad.jwt.token', {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad signature' }), { status: 400 })
      }),
    /Bad signature/
  );
});
