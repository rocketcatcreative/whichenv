import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { registerContextMenus, syncContextMenus } from '../../src/background/context-menu';
import { invalidate } from '../../src/background/index-cache';
import { PARENT_ID, itemId } from '../../src/core/menu';
import { saveGroup } from '../../src/core/storage';
import { updateSettings } from '../../src/core/settings';
import { groupWith } from '../helpers/groups';

let fake: FakeChrome;

const group = groupWith;

const acme = group('acme', 'Acme Storefront', {
  local: 'http://localhost:3000',
  staging: 'https://staging.acme.example',
  prod: 'https://acme.example',
});

/** The tab the user right-clicked in: some other site entirely, which is the point. */
const SLACK_TAB = { id: 900, url: 'https://app.slack.example/x', windowId: 10, groupId: -1 };

/** Ids present before the click, so "what got opened" is unambiguous. */
let before: Set<number>;

beforeEach(async () => {
  fake = installFakeChrome();
  invalidate();
  fake.__tabs.push({ ...SLACK_TAB });
  await saveGroup(acme);
  registerContextMenus();
  // The fake starts with an about:blank tab, so compare against a snapshot rather than
  // assuming the tab list starts empty.
  before = new Set(fake.__tabs.map((tab) => tab.id));
});

const created = () => fake.__menus.map((menu) => menu.id);
const newTabs = () => fake.__tabs.filter((tab) => !before.has(tab.id));

describe('syncContextMenus', () => {
  it('registers a parent and one child per environment, for both actions', async () => {
    await syncContextMenus();
    expect(created()).toEqual([
      PARENT_ID,
      itemId('open-link-on', 'acme', 'local'),
      itemId('open-link-on', 'acme', 'staging'),
      itemId('open-link-on', 'acme', 'prod'),
      `${PARENT_ID}-sep-copy-link-for`,
      itemId('copy-link-for', 'acme', 'local'),
      itemId('copy-link-for', 'acme', 'staging'),
      itemId('copy-link-for', 'acme', 'prod'),
    ]);
  });

  // Chrome wraps an extension's top-level items under the extension name as soon as there is
  // more than one, which would add a whole extra level of hovering.
  it('uses exactly one top-level item', async () => {
    await syncContextMenus();
    expect(fake.__menus.filter((menu) => menu.parentId === undefined)).toHaveLength(1);
  });

  it('only offers itself on links, never on the page', async () => {
    await syncContextMenus();
    for (const menu of fake.__menus) expect(menu.contexts).toEqual(['link']);
  });

  // The parent must be hidden on a link that belongs to nothing, or every link menu on the
  // web grows an "Open link on" item that does nothing.
  it('limits the parent to the union of its children’s patterns', async () => {
    await syncContextMenus();
    const parent = fake.__menus.find((menu) => menu.id === PARENT_ID);
    expect(parent?.targetUrlPatterns).toEqual([
      'http://localhost/*',
      'https://acme.example/*',
      'https://staging.acme.example/*',
    ]);
  });

  // Chrome throws on a duplicate id rather than replacing, so a rebuild that forgot to
  // clear would break on the second group edit and not the first.
  it('can be run repeatedly without colliding on ids', async () => {
    await syncContextMenus();
    await syncContextMenus();
    await expect(syncContextMenus()).resolves.toBeUndefined();
    expect(created()).toHaveLength(8);
  });

  it('clears everything when the last group goes away', async () => {
    await syncContextMenus();
    await syncContextMenus([]);
    expect(created()).toEqual([]);
  });
});

describe('clicking a link menu item', () => {
  beforeEach(async () => {
    await syncContextMenus();
  });

  it('opens the link on the chosen environment, at the same path', async () => {
    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'local'), linkUrl: 'https://acme.example/orders/42?x=1#z' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(newTabs()).toHaveLength(1);
    expect(newTabs()[0]?.url).toBe('http://localhost:3000/orders/42?x=1#z');
  });

  // Always a new tab: the page holding the link is not part of the group, so replacing it
  // is never what was asked for, whatever the global default says.
  it('opens a new tab even when the default is to replace the current one', async () => {
    await updateSettings({ openInNewTabByDefault: false });
    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'staging'), linkUrl: 'https://acme.example/a' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.__tabs.find((tab) => tab.id === SLACK_TAB.id)?.url).toBe(SLACK_TAB.url);
    expect(newTabs()[0]?.url).toBe('https://staging.acme.example/a');
  });

  it('groups the new tab and takes the page you came from with it', async () => {
    await updateSettings({ createTabGroupOnNewTab: true });
    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'prod'), linkUrl: 'https://staging.acme.example/b' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(fake.__tabGroups).toHaveLength(1);
    const groupId = fake.__tabGroups[0]?.id;
    expect(newTabs()[0]?.groupId).toBe(groupId);
    // The page the link was on comes along, so the pair you are comparing sit together.
    expect(fake.__tabs.find((tab) => tab.id === SLACK_TAB.id)?.groupId).toBe(groupId);
  });

  // The guard that makes adopting the origin safe: an arrangement the user made themselves
  // is never rearranged.
  it('leaves the page you came from alone if it is already in a group', async () => {
    await updateSettings({ createTabGroupOnNewTab: true });
    const slack = fake.__tabs.find((tab) => tab.id === SLACK_TAB.id);
    if (slack) slack.groupId = 77;

    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'prod'), linkUrl: 'https://staging.acme.example/b' },
      { ...SLACK_TAB, groupId: 77 },
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(fake.__tabs.find((tab) => tab.id === SLACK_TAB.id)?.groupId).toBe(77);
    expect(newTabs()[0]?.groupId).not.toBe(77);
  });

  it('does nothing for a link that is in no group', async () => {
    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'local'), linkUrl: 'https://unrelated.example/x' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(newTabs()).toHaveLength(0);
  });

  it('ignores a click with no link url', async () => {
    fake.__clickMenu({ menuItemId: itemId('open-link-on', 'acme', 'local') }, { ...SLACK_TAB });
    await new Promise((r) => setTimeout(r, 20));
    expect(newTabs()).toHaveLength(0);
  });

  it('ignores another extension’s menu item', async () => {
    fake.__clickMenu(
      { menuItemId: 'some-other-extension', linkUrl: 'https://acme.example/x' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(newTabs()).toHaveLength(0);
  });

  it('declines an environment the group does not have enabled', async () => {
    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'dev'), linkUrl: 'https://acme.example/x' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(newTabs()).toHaveLength(0);
  });

  // Match patterns cannot express a port, so an item from the group that owns
  // localhost:3000 shows on a link to localhost:9999. The resolved group is the truth.
  it('trusts where the link actually points over which item was clicked', async () => {
    const beta = group('beta', 'Beta', {
      local: 'http://localhost:9999',
      prod: 'https://beta.example',
    });
    await saveGroup(beta);
    invalidate();

    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'prod'), linkUrl: 'http://localhost:9999/deep' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));

    // Beta's prod, not Acme's, because the link is Beta's local.
    expect(newTabs()[0]?.url).toBe('https://beta.example/deep');
  });

  // The bug the first release shipped with. A page's links very often point at prod (a
  // canonical URL, a "view live site" link), so the link you right-click is frequently
  // already on the environment you then pick. switchTargets deliberately omits the
  // environment you are already on, so the lookup found nothing and the click did nothing
  // at all, with no feedback.
  it('opens the link as it is when the chosen environment is the one it already points at', async () => {
    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'acme', 'prod'), linkUrl: 'https://acme.example/live/page?a=1#b' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(newTabs()).toHaveLength(1);
    expect(newTabs()[0]?.url).toBe('https://acme.example/live/page?a=1#b');
  });

  it('opens a guarded environment without a second confirmation', async () => {
    const guarded = group('g', 'G', {
      local: 'http://localhost:7000',
      prod: 'https://g.example',
    }, (draft) => {
      const env = draft.environments.find((candidate) => candidate.key === 'prod');
      if (env) env.confirmOnEnter = true;
    });
    await saveGroup(guarded);
    invalidate();

    fake.__clickMenu(
      { menuItemId: itemId('open-link-on', 'g', 'prod'), linkUrl: 'http://localhost:7000/p' },
      { ...SLACK_TAB },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(newTabs()[0]?.url).toBe('https://g.example/p');
  });
});

describe('copying a link for an environment', () => {
  beforeEach(async () => {
    await syncContextMenus();
  });

  const copy = async (envKey: string, linkUrl: string) => {
    fake.__clickMenu({ menuItemId: itemId('copy-link-for', 'acme', envKey as never), linkUrl }, {
      ...SLACK_TAB,
    });
    await new Promise((r) => setTimeout(r, 30));
  };

  it('puts the translated URL on the clipboard and opens nothing', async () => {
    await copy('local', 'https://acme.example/orders/42?x=1#z');

    expect(fake.__injections).toHaveLength(1);
    expect(fake.__injections[0]?.args[0]).toBe('http://localhost:3000/orders/42?x=1#z');
    // The whole point of copying is that it does NOT navigate.
    expect(newTabs()).toHaveLength(0);
  });

  it('runs the copy in the tab the link was in, which activeTab covers', async () => {
    await copy('staging', 'https://acme.example/a');
    expect(fake.__injections[0]?.tabId).toBe(SLACK_TAB.id);
  });

  it('copies the link unchanged when it already points at the chosen environment', async () => {
    await copy('prod', 'https://acme.example/live?a=1');
    expect(fake.__injections[0]?.args[0]).toBe('https://acme.example/live?a=1');
  });

  it('copies nothing for a link that is in no group', async () => {
    await copy('local', 'https://unrelated.example/x');
    expect(fake.__injections).toHaveLength(0);
  });

  it('survives a page it cannot inject into', async () => {
    fake.__allowInjection = false;
    await expect(copy('local', 'https://acme.example/x')).resolves.toBeUndefined();
    expect(newTabs()).toHaveLength(0);
  });
});
