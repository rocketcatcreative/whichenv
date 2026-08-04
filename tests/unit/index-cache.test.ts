import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { getIndex, invalidate, rebuild } from '../../src/background/index-cache';
import { draftToGroup, emptyDraft, type EnvGroup } from '../../src/core/schema';
import { saveGroup } from '../../src/core/storage';

const NOW = 1_700_000_000_000;
let fake: FakeChrome;

function group(id: string, prodHost: string): EnvGroup {
  const draft = emptyDraft(id);
  draft.title = id;
  draft.environments = draft.environments.map((env) => ({
    ...env,
    baseUrl: env.key === 'prod' ? `https://${prodHost}` : '',
    enabled: env.key === 'prod',
  }));
  return draftToGroup(draft, NOW);
}

beforeEach(() => {
  fake = installFakeChrome();
  // The memo is module scope, which is right for a service worker (one instance) but
  // means it outlives a fresh fake. Without this, one test's index leaks into the next.
  invalidate();
});

describe('index-cache', () => {
  it('builds from stored groups on first read', async () => {
    await saveGroup(group('a', 'alpha.example'));
    const index = await getIndex();
    expect(Object.keys(index.byOrigin)).toEqual(['https://alpha.example:443']);
    expect(index.groupCount).toBe(1);
  });

  it('writes the index to session storage', async () => {
    await saveGroup(group('a', 'alpha.example'));
    await getIndex();
    expect(fake.__session.has('match:index')).toBe(true);
  });

  // The whole point of the cache: resolving a page load must not hit sync storage.
  it('serves later reads without touching sync storage again', async () => {
    await saveGroup(group('a', 'alpha.example'));
    await getIndex();

    const spy = vi.spyOn(fake.storage.sync, 'get');
    await getIndex();
    await getIndex();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rebuilds from an explicit group list without reading storage', async () => {
    const spy = vi.spyOn(fake.storage.sync, 'get');
    const index = await rebuild([group('b', 'beta.example')]);
    expect(Object.keys(index.byOrigin)).toEqual(['https://beta.example:443']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reflects a rebuild on the next read', async () => {
    await saveGroup(group('a', 'alpha.example'));
    await getIndex();

    await saveGroup(group('b', 'beta.example'));
    await rebuild();

    expect(Object.keys((await getIndex()).byOrigin).sort()).toEqual([
      'https://alpha.example:443',
      'https://beta.example:443',
    ]);
  });

  // Invalidation is what stops a stale index serving matches after an edit.
  it('rebuilds from storage after being invalidated', async () => {
    await saveGroup(group('a', 'alpha.example'));
    await getIndex();

    await saveGroup(group('b', 'beta.example'));
    invalidate();

    expect(Object.keys((await getIndex()).byOrigin).sort()).toEqual([
      'https://alpha.example:443',
      'https://beta.example:443',
    ]);
  });

  // Service workers are killed aggressively, so the module memo cannot be trusted to
  // survive. The session copy is what makes a cold start cheap.
  it('recovers the cached index from session storage without rebuilding', async () => {
    await saveGroup(group('a', 'alpha.example'));
    await getIndex();

    // Simulate a fresh worker: module memo gone, session storage intact.
    invalidate();
    await fake.storage.session.set({
      'match:index': {
        byOrigin: { 'https://cached.example:443': [] },
        wildcards: [],
        groupCount: 99,
      },
    });

    const index = await getIndex();
    expect(index.groupCount).toBe(99);
  });

  // storage.session outlives an extension reload, so a cache written by a build that
  // predates the wildcard bucket can still be sitting there. Serving it would mean no
  // wildcard resolves until the browser is restarted, which is the kind of bug that gets
  // reported as "it works on my other machine".
  it('rebuilds a cached index that predates the wildcard bucket', async () => {
    await saveGroup(group('a', 'alpha.example'));
    invalidate();
    await fake.storage.session.set({
      'match:index': { byOrigin: { 'https://cached.example:443': [] }, groupCount: 99 },
    });

    const index = await getIndex();
    expect(index.groupCount).toBe(1);
    expect(Object.keys(index.byOrigin)).toEqual(['https://alpha.example:443']);
    expect(index.wildcards).toEqual([]);
  });

  it('ignores a corrupt cached value and rebuilds', async () => {
    await saveGroup(group('a', 'alpha.example'));
    invalidate();
    await fake.storage.session.set({ 'match:index': 'not an index' });

    expect(Object.keys((await getIndex()).byOrigin)).toEqual(['https://alpha.example:443']);
  });

  it('handles an empty config', async () => {
    expect(await getIndex()).toEqual({ byOrigin: {}, wildcards: [], groupCount: 0 });
  });
});
