import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { guardsInPlay, openAllPlan, sameTarget } from '../../src/core/open-all';
import { openAllEnvironments } from '../../src/background/open-all';
import { buildIndex, lookup, resolveMatch, type Match } from '../../src/core/match';
import { DEFAULT_PALETTE_ID } from '../../src/core/palette';
import { saveGroup } from '../../src/core/storage';
import { groupWith } from '../helpers/groups';

const storefront = groupWith('sf', 'Acme Storefront', {
  local: 'http://localhost:3000',
  dev: 'https://dev.acme.example',
  staging: 'https://staging.acme.example',
  prod: 'https://acme.example',
});

/** The Match a given URL resolves to inside a given group. */
function matchFor(url: string, group = storefront): Match {
  const entry = lookup(buildIndex([group]), url);
  if (!entry) throw new Error(`No index entry for ${url}`);
  const match = resolveMatch([group], entry);
  if (!match) throw new Error(`No match for ${url}`);
  return match;
}

describe('openAllPlan', () => {
  // Pipeline order rather than the group's configured order. The value of a wall of tabs is
  // that the leftmost is always the safest and the rightmost is always production, and that
  // has to hold across every group or the strip stops being readable at a glance.
  it('orders every environment local to prod, whatever order the group is in', () => {
    const reversed = groupWith('r', 'Reversed', {
      local: 'http://localhost:3000',
      staging: 'https://staging.acme.example',
      prod: 'https://acme.example',
    });
    reversed.environments.reverse();

    const plan = openAllPlan(matchFor('https://staging.acme.example/x', reversed), 'https://staging.acme.example/x');
    expect(plan.map((stop) => stop.envKey)).toEqual(['local', 'staging', 'prod']);
  });

  it('includes the environment the tab is already on, marked as current', () => {
    const plan = openAllPlan(matchFor('https://staging.acme.example/p/1'), 'https://staging.acme.example/p/1');
    const current = plan.filter((stop) => stop.current);

    expect(current).toHaveLength(1);
    expect(current[0]?.envKey).toBe('staging');
    expect(current[0]?.url).toBe('https://staging.acme.example/p/1');
  });

  // The guard is about entering an environment, and you are already in this one.
  it('never guards the environment you are already on', () => {
    const guarded = groupWith('g', 'Guarded', {
      staging: 'https://staging.acme.example',
      prod: 'https://acme.example',
    }, (draft) => {
      for (const env of draft.environments) env.confirmOnEnter = true;
    });

    const plan = openAllPlan(matchFor('https://acme.example/', guarded), 'https://acme.example/');
    expect(plan.find((stop) => stop.current)?.confirmOnEnter).toBe(false);
    expect(plan.find((stop) => !stop.current)?.confirmOnEnter).toBe(true);
  });

  it('carries the current path onto every environment', () => {
    const plan = openAllPlan(matchFor('https://acme.example/products/42?x=1'), 'https://acme.example/products/42?x=1');
    for (const stop of plan) expect(stop.url).toContain('/products/42?x=1');
  });

  // Everything switchTargets already refuses is refused here too, for free.
  it('leaves out environments with nowhere to go', () => {
    const partial = groupWith('p', 'Partial', {
      staging: 'https://staging.acme.example',
      prod: 'https://acme.example',
    });
    const plan = openAllPlan(matchFor('https://acme.example/', partial), 'https://acme.example/');
    expect(plan.map((stop) => stop.envKey)).toEqual(['staging', 'prod']);
  });
});

describe('guardsInPlay', () => {
  it('is true when any sibling carries the enter guard', () => {
    expect(guardsInPlay([{ confirmOnEnter: false }, { confirmOnEnter: true }])).toBe(true);
    expect(guardsInPlay([{ confirmOnEnter: false }])).toBe(false);
    expect(guardsInPlay([])).toBe(false);
  });
});

describe('sameTarget', () => {
  it('forgives a trailing slash on the root path', () => {
    expect(sameTarget('https://acme.example', 'https://acme.example/')).toBe(true);
  });

  it('forgives a trailing slash on a deeper path', () => {
    expect(sameTarget('https://acme.example/docs/', 'https://acme.example/docs')).toBe(true);
  });

  // A tab on a different query or route is not the tab you asked for.
  it('treats a different query or fragment as a different page', () => {
    expect(sameTarget('https://acme.example/?a=1', 'https://acme.example/?a=2')).toBe(false);
    expect(sameTarget('https://acme.example/#/a', 'https://acme.example/#/b')).toBe(false);
  });

  it('is false for anything unparseable, rather than throwing', () => {
    expect(sameTarget('', 'https://acme.example/')).toBe(false);
    expect(sameTarget('not a url', 'https://acme.example/')).toBe(false);
  });
});

describe('openAllEnvironments', () => {
  let fake: FakeChrome;

  /** Adds a tab to window 10 and returns its id. */
  function addTab(url: string, windowId = 10): number {
    const id = 500 + fake.__tabs.length;
    fake.__tabs.push({ id, url, windowId, groupId: -1 });
    return id;
  }

  /** The tabs of window 10, in strip order, as URLs. */
  const strip = (windowId = 10): string[] =>
    fake.__tabs.filter((tab) => tab.windowId === windowId).map((tab) => tab.url);

  beforeEach(async () => {
    fake = installFakeChrome();
    fake.__tabs.length = 0;
    await saveGroup(storefront);
  });

  const run = async (url: string, originTabId: number) =>
    openAllEnvironments(matchFor(url), url, originTabId, 10, DEFAULT_PALETTE_ID);

  it('opens the missing environments and leaves the current tab where it is', async () => {
    const origin = addTab('https://staging.acme.example/p/1');
    const result = await run('https://staging.acme.example/p/1', origin);

    expect(result).toEqual({ opened: 3, adopted: 0 });
    expect(fake.__tabs).toHaveLength(4);
    expect(fake.__tabs.find((tab) => tab.id === origin)?.url).toBe('https://staging.acme.example/p/1');
  });

  it('leaves the tab strip in pipeline order', async () => {
    const origin = addTab('https://acme.example/p/1');
    await run('https://acme.example/p/1', origin);

    expect(strip()).toEqual([
      'http://localhost:3000/p/1',
      'https://dev.acme.example/p/1',
      'https://staging.acme.example/p/1',
      'https://acme.example/p/1',
    ]);
  });

  it('puts every tab in one group, titled after the environment group', async () => {
    const origin = addTab('https://acme.example/');
    await run('https://acme.example/', origin);

    expect(fake.__tabGroups).toHaveLength(1);
    expect(fake.__tabGroups[0]?.title).toBe('Acme Storefront');

    const groupId = fake.__tabGroups[0]?.id;
    for (const tab of fake.__tabs) expect(tab.groupId).toBe(groupId);
  });

  // The tab you pressed it from is pulled in whatever state it is in, unlike a plain switch.
  it('takes the originating tab even when it is already in another group', async () => {
    const origin = addTab('https://acme.example/');
    const mine = fake.__tabs.find((tab) => tab.id === origin);
    if (mine) mine.groupId = 999;

    await run('https://acme.example/', origin);
    expect(fake.__tabs.find((tab) => tab.id === origin)?.groupId).not.toBe(999);
  });

  it('adopts a tab already showing one of the destinations instead of duplicating it', async () => {
    const origin = addTab('https://acme.example/p/1');
    const already = addTab('https://staging.acme.example/p/1');

    const result = await run('https://acme.example/p/1', origin);

    expect(result).toEqual({ opened: 2, adopted: 1 });
    expect(fake.__tabs).toHaveLength(4);
    expect(fake.__tabs.some((tab) => tab.id === already)).toBe(true);
  });

  // The property adoption exists for: this is a button people press twice.
  it('is idempotent when pressed again', async () => {
    const origin = addTab('https://acme.example/p/1');
    await run('https://acme.example/p/1', origin);
    const after = fake.__tabs.length;

    const second = await run('https://acme.example/p/1', origin);

    expect(fake.__tabs).toHaveLength(after);
    expect(second).toEqual({ opened: 0, adopted: 3 });
  });

  it('ignores tabs in other windows when looking for something to adopt', async () => {
    const origin = addTab('https://acme.example/');
    addTab('https://staging.acme.example/', 11);

    expect(await run('https://acme.example/', origin)).toEqual({ opened: 3, adopted: 0 });
  });

  it('opens every new tab in the background, so focus stays put', async () => {
    const origin = addTab('https://acme.example/');
    await run('https://acme.example/', origin);

    for (const tab of fake.__tabs) {
      if (tab.id !== origin) expect(tab.active, tab.url).toBeFalsy();
    }
  });

  it('does nothing for a group whose only reachable environment is the current one', async () => {
    const alone = groupWith('a', 'Alone', { prod: 'https://solo.example' });
    await saveGroup(alone);

    const origin = addTab('https://solo.example/');
    const result = await openAllEnvironments(
      matchFor('https://solo.example/', alone),
      'https://solo.example/',
      origin,
      10,
      DEFAULT_PALETTE_ID,
    );

    expect(result).toBeNull();
    expect(fake.__tabs).toHaveLength(1);
  });
});
