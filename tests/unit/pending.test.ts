import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { draftFromGuess, stashDraft, takeDraft } from '../../src/core/pending';
import { guessGroupFromUrl } from '../../src/core/guess';
import { emptyDraft } from '../../src/core/schema';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
});

describe('draftFromGuess', () => {
  it('carries the guessed title and URLs into an editable draft', () => {
    const guess = guessGroupFromUrl('https://staging.acme.example/x', 'Acme Store', {
      localPort: 3300,
    })!;
    const draft = draftFromGuess(guess, 'draft-id');

    expect(draft.id).toBe('draft-id');
    expect(draft.title).toBe('Acme Store');

    const byKey = Object.fromEntries(draft.environments.map((env) => [env.key, env]));
    expect(byKey.staging?.baseUrl).toBe('https://staging.acme.example');
    expect(byKey.staging?.enabled).toBe(true);
    expect(byKey.prod?.baseUrl).toBe('https://acme.example');
    expect(byKey.prod?.enabled).toBe(false);
    expect(byKey.local?.baseUrl).toBe('http://localhost:3300');
  });

  it('keeps the four default rows in pipeline order', () => {
    const guess = guessGroupFromUrl('https://acme.example/', undefined, { localPort: 3000 })!;
    expect(draftFromGuess(guess, 'x').environments.map((env) => env.key)).toEqual([
      'local', 'dev', 'staging', 'prod',
    ]);
  });

  it('produces a draft the editor can consume unchanged', () => {
    const guess = guessGroupFromUrl('https://acme.example/', undefined, { localPort: 3000 })!;
    const draft = draftFromGuess(guess, 'x');
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
