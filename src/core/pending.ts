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

import { emptyDraft, type GroupDraft } from './schema';
import { titleFromTab } from './naming';
import { parseBaseUrl } from './url';

const KEY = 'pending:draft';

/**
 * Turns the active tab into an editable draft.
 *
 * One row, holding the URL you are actually looking at, plus a name. Nothing else is
 * inferred. An earlier version filled in `staging.<apex>`, `dev.<apex>` and a loopback
 * port as well, on the theory that a guess you can correct beats a blank form. It does
 * not: environment URLs follow no convention reliable enough to bet on, so those rows
 * were usually wrong, and wrong-but-plausible is the expensive kind of wrong. You would
 * accept them without reading and get a switch target pointing at a hostname that does
 * not resolve, or worse, at someone else's site.
 *
 * The row is production because that is what a blank group starts with, and because an
 * unverified environment is safest labelled as the one you must be careful on. Changing
 * it is a dropdown away, and the editor is open in front of you.
 *
 * Returns null for anything that is not a usable base URL, which the caller reports.
 */
export function draftFromTab(url: string, pageTitle: string | undefined, id: string): GroupDraft | null {
  const parsed = parseBaseUrl(url);
  if (!parsed.ok) return null;

  const draft = emptyDraft(id);
  draft.title = titleFromTab(parsed.value.host, pageTitle);

  const first = draft.environments[0];
  if (!first) return null;
  first.baseUrl = `${parsed.value.scheme}://${parsed.value.authority}`;

  return draft;
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
