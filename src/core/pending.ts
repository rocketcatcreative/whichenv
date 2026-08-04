/**
 * Handing a prefilled draft from the popup to the options page.
 *
 * The popup cannot host the editor: it closes the moment focus leaves it, which is
 * the moment you click into a field. So "create a group from this tab" happens in the
 * popup, stashes the draft, and opens the options page to finish the job.
 *
 * `chrome.storage.session` is the right home for it. The handoff is meaningless once
 * the browser restarts, and it must survive the service worker being torn down
 * between the popup closing and the options page loading.
 */

import { emptyDraft, newEnvironmentDraft, type EnvironmentDraft, type GroupDraft } from './schema';
import { byPipelineOrder } from './palette';
import type { GuessedGroup } from './guess';

const KEY = 'pending:draft';

/**
 * Turns a guess into an editable draft.
 *
 * Builds the environment list from the GUESS, not from the blank draft. It used to map over
 * the blank draft's rows and fill the ones that matched, which worked only while a blank
 * group happened to start with the same four environments the guesser produces. Once a blank
 * group started with production alone, that quietly threw away every guess but prod, gutting
 * the feature. Adding a row per guess is what the function was always meant to do.
 *
 * Anything the guesser did not produce is kept, so a blank row is never silently dropped, and
 * the result is sorted into pipeline order so the editor reads local to production regardless
 * of which order things arrived in.
 */
export function draftFromGuess(guess: GuessedGroup, id: string): GroupDraft {
  const base = emptyDraft(id);
  base.title = guess.title;

  const byKey = new Map<string, EnvironmentDraft>(
    base.environments.map((env) => [env.key, env]),
  );

  for (const guessed of guess.environments) {
    const existing = byKey.get(guessed.key) ?? newEnvironmentDraft(guessed.key);
    byKey.set(guessed.key, {
      ...existing,
      baseUrl: guessed.baseUrl,
      enabled: guessed.enabled,
    });
  }

  base.environments = [...byKey.values()].sort((a, b) => byPipelineOrder(a.key, b.key));

  return base;
}

export async function stashDraft(draft: GroupDraft): Promise<void> {
  await chrome.storage.session.set({ [KEY]: draft });
}

/**
 * Reads the stashed draft and clears it.
 *
 * Clearing on read is deliberate: reloading the options page should not reopen an
 * editor you already dismissed.
 */
export async function takeDraft(): Promise<GroupDraft | null> {
  const stored = await chrome.storage.session.get(KEY);
  const draft = stored[KEY];
  if (draft === undefined) return null;

  await chrome.storage.session.remove(KEY);

  if (typeof draft !== 'object' || draft === null) return null;
  const candidate = draft as Partial<GroupDraft>;
  if (typeof candidate.id !== 'string' || !Array.isArray(candidate.environments)) return null;

  return candidate as GroupDraft;
}
