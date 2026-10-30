import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { draftFromTab, stashDraft, takeDraft } from '../../src/core/pending';
import { emptyDraft } from '../../src/core/schema';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
});

describe('draftFromTab', () => {
  it('carries the title and the tab’s own URL into an editable draft', () => {
    const draft = draftFromTab('https://staging.acme.example/x?y=1', 'Acme Store', 'draft-id')!;

    expect(draft.id).toBe('draft-id');
    expect(draft.title).toBe('Acme Store');
    expect(draft.environments).toHaveLength(1);
    expect(draft.environments[0]?.key).toBe('prod');
    expect(draft.environments[0]?.baseUrl).toBe('https://staging.acme.example');
  });

  it('names the group from the domain when the tab has no title', () => {
    expect(draftFromTab('https://acme.example/', undefined, 'x')?.title).toBe('Acme');
  });

  // The whole point of the change. Anything that fabricates a hostname from the apex is a
  // switch target pointing somewhere nobody confirmed, and it gets accepted unread.
  it('invents no URL other than the one the tab is on', () => {
    const draft = draftFromTab('https://acme.example/', undefined, 'x')!;
    const urls = draft.environments.map((env) => env.baseUrl);
    expect(urls).toEqual(['https://acme.example']);
    expect(urls.some((url) => /staging|dev|localhost/.test(url))).toBe(false);
  });

  it('returns null for a URL that cannot be a base URL', () => {
    expect(draftFromTab('chrome://extensions', undefined, 'x')).toBeNull();
    expect(draftFromTab('not a url at all !!', undefined, 'x')).toBeNull();
  });

  it('keeps the port when it is not the scheme default', () => {
    expect(draftFromTab('https://acme.example:8443/', undefined, 'x')?.environments[0]?.baseUrl)
      .toBe('https://acme.example:8443');
  });

  it('produces a draft the editor can consume unchanged', () => {
    const draft = draftFromTab('https://acme.example/', undefined, 'x')!;
    const shape = emptyDraft('x');
    expect(Object.keys(draft).sort()).toEqual(Object.keys(shape).sort());
    for (const env of draft.environments) {
      expect(Object.keys(env).sort()).toEqual(Object.keys(shape.environments[0]!).sort());
    }
  });
});

describe('stash and take', () => {
  it('round trips a draft', async () => {
    const draft = { ...emptyDraft('abc'), title: 'Handed over' };
    await stashDraft(draft);
    expect(await takeDraft()).toEqual(draft);
  });

  it('returns null when nothing was stashed', async () => {
    expect(await takeDraft()).toBeNull();
  });

  // Clearing on read is what stops a reload reopening an editor you dismissed.
  it('clears the stash as it reads', async () => {
    await stashDraft(emptyDraft('abc'));
    expect(await takeDraft()).not.toBeNull();
    expect(await takeDraft()).toBeNull();
    expect(fake.__session.has('pending:draft')).toBe(false);
  });

  it('lives in session storage, not sync, since the handoff is momentary', async () => {
    await stashDraft(emptyDraft('abc'));
    expect(fake.__session.has('pending:draft')).toBe(true);
    expect([...fake.__data.keys()]).toEqual([]);
  });

  it('rejects a stashed value that is not a draft', async () => {
    for (const junk of ['a string', 42, null, { id: 'x' }, { environments: [] }]) {
      await fake.storage.session.set({ 'pending:draft': junk });
      expect(await takeDraft()).toBeNull();
    }
  });
});
