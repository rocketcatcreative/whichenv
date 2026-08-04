import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { forgetWindow, groupTab as groupTabWith } from '../../src/background/tab-groups';
import type { EnvKey, PaletteId } from '../../src/core/palette';
import type { EnvGroup } from '../../src/core/schema';
import { saveGroup } from '../../src/core/storage';
import { groupWith } from '../helpers/groups';

let fake: FakeChrome;

const envGroup = groupWith;

const storefront = envGroup('sf', 'Acme Storefront', {
  local: 'http://localhost:3000',
  staging: 'https://staging.acme.example',
  prod: 'https://acme.example',
});

/** Adds a tab in window 10 and returns its id. */
function addTab(url: string, windowId = 10): number {
  const id = 500 + fake.__tabs.length;
  fake.__tabs.push({ id, url, windowId, groupId: -1 });
  return id;
}

const onlyGroup = () => fake.__tabGroups[0];

/**
 * groupTab with the palette pinned to the default.
 *
 * Almost every test here is about which tabs end up in which group, not about colour,
 * so the palette is noise in those call signatures. The one test that does care passes
 * a set explicitly via groupTabWith.
 */
const groupTab = (
  tabId: number,
  windowId: number,
  group: EnvGroup,
  envKey: EnvKey,
  originTabId?: number,
): Promise<void> => groupTabWith(tabId, windowId, group, envKey, 'default', originTabId);

beforeEach(async () => {
  fake = installFakeChrome();
  await saveGroup(storefront);
});

describe('groupTab', () => {
  it('creates a tab group named after the environment group', async () => {
    const tabId = addTab('https://staging.acme.example/x');
    await groupTab(tabId, 10, storefront, 'staging');

    expect(fake.__tabGroups).toHaveLength(1);
    expect(onlyGroup()?.title).toBe('Acme Storefront');
    expect(fake.__tabs.find((tab) => tab.id === tabId)?.groupId).toBe(onlyGroup()?.id);
  });

  it('colours the group from the palette mapping', async () => {
    const tabId = addTab('https://staging.acme.example/x');
    await groupTab(tabId, 10, storefront, 'staging');
    expect(onlyGroup()?.color).toBe('orange');
  });

  // The chosen colour set has to reach the tab strip too, or the tab group is the one
  // place still showing the old palette.
  it.each<[PaletteId, string]>([
    ['default', 'orange'],
    ['vivid', 'yellow'],
    ['muted', 'yellow'],
    ['deuteranopia', 'yellow'],
  ])('colours the group using the %s set', async (palette, expected) => {
    const tabId = addTab('https://staging.acme.example/x');
    await groupTabWith(tabId, 10, storefront, 'staging', palette);
    expect(onlyGroup()?.color).toBe(expected);
  });

  // One group per site, not per environment: comparing prod against staging means
  // two tabs about the same site, and they belong together.
  it('reuses the same group for a second environment of the same site', async () => {
    const first = addTab('https://staging.acme.example/x');
    await groupTab(first, 10, storefront, 'staging');

    const second = addTab('http://localhost:3000/x');
    await groupTab(second, 10, storefront, 'local');

    expect(fake.__tabGroups).toHaveLength(1);
    expect(fake.__tabs.find((tab) => tab.id === second)?.groupId).toBe(onlyGroup()?.id);
  });

  // The colour rule: one prod tab anywhere in the group and the whole thing reads
  // red, because that is the fact worth knowing at a glance.
  it('takes the colour of the riskiest environment in the group', async () => {
    const staging = addTab('https://staging.acme.example/x');
    await groupTab(staging, 10, storefront, 'staging');
    expect(onlyGroup()?.color).toBe('orange');

    const prod = addTab('https://acme.example/x');
    await groupTab(prod, 10, storefront, 'prod');
    expect(onlyGroup()?.color).toBe('red');
  });

  it('does not downgrade the colour when a lower-risk tab joins', async () => {
    const prod = addTab('https://acme.example/x');
    await groupTab(prod, 10, storefront, 'prod');
    expect(onlyGroup()?.color).toBe('red');

    const local = addTab('http://localhost:3000/x');
    await groupTab(local, 10, storefront, 'local');
    expect(onlyGroup()?.color).toBe('red');
  });

  it('keeps separate groups for separate sites', async () => {
    const other = envGroup('db', 'Acme Dashboard', { prod: 'https://dash.acme.example' });
    await saveGroup(other);

    await groupTab(addTab('https://acme.example/x'), 10, storefront, 'prod');
    await groupTab(addTab('https://dash.acme.example/x'), 10, other, 'prod');

    expect(fake.__tabGroups).toHaveLength(2);
    expect(fake.__tabGroups.map((group) => group.title).sort()).toEqual([
      'Acme Dashboard',
      'Acme Storefront',
    ]);
  });

  it('keeps separate groups per window', async () => {
    await groupTab(addTab('https://acme.example/x', 10), 10, storefront, 'prod');
    await groupTab(addTab('https://staging.acme.example/x', 20), 20, storefront, 'staging');

    expect(fake.__tabGroups).toHaveLength(2);
    expect(fake.__tabGroups.map((group) => group.windowId).sort()).toEqual([10, 20]);
  });

  // The remembered id is what survives the user renaming the tab group; without it
  // a rename would orphan the group and the next switch would make a second one.
  it('reuses a group the user has renamed', async () => {
    const first = addTab('https://staging.acme.example/x');
    await groupTab(first, 10, storefront, 'staging');
    const groupId = onlyGroup()!.id;

    await fake.tabGroups.update(groupId, { title: 'My own name' });

    const second = addTab('https://acme.example/x');
    await groupTab(second, 10, storefront, 'prod');

    expect(fake.__tabGroups).toHaveLength(1);
    expect(fake.__tabs.find((tab) => tab.id === second)?.groupId).toBe(groupId);
  });

  // And the title match is what survives the service worker losing session storage.
  it('finds an existing group by title when the remembered id is gone', async () => {
    const first = addTab('https://staging.acme.example/x');
    await groupTab(first, 10, storefront, 'staging');
    const groupId = onlyGroup()!.id;

    fake.__session.clear();

    const second = addTab('https://acme.example/x');
    await groupTab(second, 10, storefront, 'prod');

    expect(fake.__tabGroups).toHaveLength(1);
    expect(fake.__tabs.find((tab) => tab.id === second)?.groupId).toBe(groupId);
  });

  it('creates a fresh group when the remembered one has closed', async () => {
    const first = addTab('https://staging.acme.example/x');
    await groupTab(first, 10, storefront, 'staging');

    // Simulate the group being closed: remove it but leave the assignment behind.
    fake.__tabGroups.length = 0;

    const second = addTab('https://acme.example/x');
    await groupTab(second, 10, storefront, 'prod');

    expect(fake.__tabGroups).toHaveLength(1);
    expect(onlyGroup()?.title).toBe('Acme Storefront');
  });

  // Grouping is a convenience layered on navigation. The switch has already
  // happened by the time this runs, so a failure must never surface as an error.
  it('never throws, even when the tab does not exist', async () => {
    await expect(groupTab(9999, 10, storefront, 'prod')).resolves.toBeUndefined();
  });

  it('ignores tabs whose URL cannot be read when picking the colour', async () => {
    const staging = addTab('https://staging.acme.example/x');
    await groupTab(staging, 10, storefront, 'staging');

    // A tab on an origin we hold no permission for: url is undefined in real Chrome.
    const opaque = 600;
    fake.__tabs.push({ id: opaque, url: '', windowId: 10, groupId: onlyGroup()!.id });

    const local = addTab('http://localhost:3000/x');
    await groupTab(local, 10, storefront, 'local');
    expect(onlyGroup()?.color).toBe('orange');
  });
});

/**
 * Grouping only the new tab would leave the pair split, which defeats the point:
 * the two tabs you are comparing end up in different places.
 */
describe('adopting the tab a switch came from', () => {
  it('pulls an ungrouped origin tab into the new group', async () => {
    const origin = addTab('https://acme.example/x');
    const created = addTab('https://staging.acme.example/x');

    await groupTab(created, 10, storefront, 'staging', origin);

    const groupId = onlyGroup()!.id;
    expect(fake.__tabs.find((tab) => tab.id === origin)?.groupId).toBe(groupId);
    expect(fake.__tabs.find((tab) => tab.id === created)?.groupId).toBe(groupId);
  });

  it('pulls it in when joining an existing group too, not only a new one', async () => {
    const first = addTab('https://staging.acme.example/a');
    await groupTab(first, 10, storefront, 'staging');
    const groupId = onlyGroup()!.id;

    const origin = addTab('https://acme.example/x');
    const created = addTab('http://localhost:3000/x');
    await groupTab(created, 10, storefront, 'local', origin);

    expect(fake.__tabGroups).toHaveLength(1);
    expect(fake.__tabs.find((tab) => tab.id === origin)?.groupId).toBe(groupId);
  });

  // A tab already in a group belongs to an arrangement the user made.
  it('leaves an origin tab that is already grouped exactly where it is', async () => {
    const theirs = 900;
    fake.__tabGroups.push({ id: theirs, windowId: 10, title: 'Their own group' });
    const origin = addTab('https://acme.example/x');
    const originTab = fake.__tabs.find((tab) => tab.id === origin)!;
    originTab.groupId = theirs;

    const created = addTab('https://staging.acme.example/x');
    await groupTab(created, 10, storefront, 'staging', origin);

    expect(originTab.groupId).toBe(theirs);
    expect(fake.__tabs.find((tab) => tab.id === created)?.groupId).not.toBe(theirs);
  });

  it('ignores an origin tab in a different window', async () => {
    const origin = addTab('https://acme.example/x', 20);
    const created = addTab('https://staging.acme.example/x', 10);

    await groupTab(created, 10, storefront, 'staging', origin);
    expect(fake.__tabs.find((tab) => tab.id === origin)?.groupId).toBe(-1);
  });

  it('ignores an origin tab that has since closed', async () => {
    const created = addTab('https://staging.acme.example/x');
    await expect(groupTab(created, 10, storefront, 'staging', 9999)).resolves.toBeUndefined();
    expect(fake.__tabs.find((tab) => tab.id === created)?.groupId).toBe(onlyGroup()?.id);
  });

  it('does nothing surprising when the origin is the new tab itself', async () => {
    const created = addTab('https://staging.acme.example/x');
    await groupTab(created, 10, storefront, 'staging', created);
    expect(fake.__tabs.filter((tab) => tab.groupId === onlyGroup()?.id)).toHaveLength(1);
  });

  // Adopting the origin means its environment counts toward the colour.
  it('takes the riskier colour once the origin is adopted', async () => {
    const origin = addTab('https://acme.example/x');
    const created = addTab('http://localhost:3000/x');

    await groupTab(created, 10, storefront, 'local', origin);
    expect(onlyGroup()?.color).toBe('red');
  });
});

describe('forgetWindow', () => {
  it('drops assignments for a closed window and keeps the rest', async () => {
    await groupTab(addTab('https://acme.example/x', 10), 10, storefront, 'prod');
    await groupTab(addTab('https://staging.acme.example/x', 20), 20, storefront, 'staging');

    await forgetWindow(10);

    const assignments = fake.__session.get('tabgroups') as Record<string, number>;
    expect(Object.keys(assignments)).toEqual(['20:sf']);
  });

  it('is a no-op for a window with no assignments', async () => {
    await expect(forgetWindow(99)).resolves.toBeUndefined();
  });
});
