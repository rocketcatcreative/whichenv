/**
 * Dynamic content script registration.
 *
 * The manifest statically covers loopback hosts only. Every other origin gets its
 * content script registered here, once its host permission has been granted, so
 * install time asks for nothing and the extension can genuinely only see the sites
 * you told it about.
 *
 * Registration is derived from the granted permissions rather than from the groups,
 * which means the two can never disagree: if access was revoked in Chrome's own UI,
 * the script stops being registered on the next sync without the extension needing
 * to notice separately.
 */

import { ALL_URLS, STATIC_MATCHES } from '@core/permissions';

const SCRIPT_ID = 'es-indicator';
const CONTENT_JS = 'content/indicator.js';

/** The origins worth registering for: granted, minus what the manifest covers. */
async function dynamicMatches(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  const origins = all.origins ?? [];

  if (origins.includes(ALL_URLS)) return [ALL_URLS];

  return origins.filter((origin) => !STATIC_MATCHES.includes(origin)).sort();
}

async function currentRegistration(): Promise<chrome.scripting.RegisteredContentScript | null> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    return existing[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Brings the registered content script in line with the granted permissions.
 *
 * Idempotent and safe to call often: it compares against what is already registered
 * and does nothing when they match, which matters because it runs on every
 * permission change and every group change.
 */
export async function syncRegistrations(): Promise<void> {
  const matches = await dynamicMatches();
  const existing = await currentRegistration();

  if (matches.length === 0) {
    if (existing) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      } catch {
        // Nothing registered after all. Not a problem.
      }
    }
    return;
  }

  const sameAsExisting =
    existing !== null &&
    [...(existing.matches ?? [])].sort().join(' ') === matches.join(' ');
  if (sameAsExisting) return;

  const script: chrome.scripting.RegisteredContentScript = {
    id: SCRIPT_ID,
    matches,
    js: [CONTENT_JS],
    runAt: 'document_idle',
    allFrames: false,
    // Survives browser restarts, so a page loaded before the worker wakes still
    // gets its indicator.
    persistAcrossSessions: true,
  };

  try {
    if (existing) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (error) {
    // The most likely cause is a permission that was revoked between reading it
    // and registering. The next sync will settle it.
    console.warn('[WhichEnv] could not register content scripts', error);
  }
}
