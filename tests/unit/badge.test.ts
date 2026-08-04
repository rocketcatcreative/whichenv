import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { refreshAllBadges, refreshBadge, updateBadge } from '../../src/background/badge';
import { saveGroup } from '../../src/core/storage';
import { groupWith } from '../helpers/groups';

let fake: FakeChrome;

const group = groupWith;

const storefront = group('sf', 'Acme Storefront', {
  local: 'http://localhost:3000',
  staging: 'https://staging.acme.example',
  prod: 'https://acme.example',
});

function addTab(id: number, url: string): void {
  fake.__tabs.push({ id, url, windowId: 10, groupId: -1 });
}

const badge = (tabId: number) => fake.__badges.get(tabId);

beforeEach(async () => {
  fake = installFakeChrome();
  await saveGroup(storefront);
});

describe('updateBadge', () => {
  it('shows the environment code and colours it from the palette', async () => {
    addTab(2, 'https://staging.acme.example/x');
    await updateBadge(2, 'https://staging.acme.example/x');

    expect(badge(2)?.text).toBe('STG');
    expect(badge(2)?.background).toBe('#F59E0B');
    // Staging is the one environment with dark text, so this catches a wrong pairing.
    expect(badge(2)?.textColor).toBe('#1C1917');
  });

  it('names the environment and group in the tooltip', async () => {
    addTab(2, 'https://acme.example/x');
    await updateBadge(2, 'https://acme.example/x');
    expect(badge(2)?.title).toBe('Production on Acme Storefront');
  });

  it('uses a three letter code for every environment', async () => {
    addTab(2, 'http://localhost:3000/x');
    await updateBadge(2, 'http://localhost:3000/x');
    expect(badge(2)?.text).toBe('LOC');
  });

  it('clears the badge for a URL in no group', async () => {
    addTab(2, 'https://unrelated.example/x');
    await updateBadge(2, 'https://unrelated.example/x');
    expect(badge(2)?.text).toBe('');
    expect(badge(2)?.title).toBe('WhichEnv');
  });

  // An unreadable URL means an origin with no host permission, which is also an origin
  // that cannot be in any group. Clearing is the correct outcome, not a gap.
  it('clears the badge when the URL cannot be read', async () => {
    addTab(2, '');
    await updateBadge(2, undefined);
    expect(badge(2)?.text).toBe('');
  });

  it('clears the badge for a non-http URL', async () => {
    addTab(2, 'chrome://extensions');
    await updateBadge(2, 'chrome://extensions');
    expect(badge(2)?.text).toBe('');
  });

  // Badges are resolved asynchronously, so the tab may be gone by the time we write.
  it('never throws when the tab has closed', async () => {
    await expect(updateBadge(999, 'https://acme.example/x')).resolves.toBeUndefined();
    await expect(updateBadge(999, undefined)).resolves.toBeUndefined();
  });

  it('keeps badges independent per tab', async () => {
    addTab(2, 'https://acme.example/x');
    addTab(3, 'http://localhost:3000/x');
    await updateBadge(2, 'https://acme.example/x');
    await updateBadge(3, 'http://localhost:3000/x');

    expect(badge(2)?.text).toBe('PRD');
    expect(badge(3)?.text).toBe('LOC');
  });
});

describe('refreshBadge', () => {
  it('looks the URL up from the tab id', async () => {
    addTab(2, 'https://staging.acme.example/x');
    await refreshBadge(2);
    expect(badge(2)?.text).toBe('STG');
  });

  it('never throws for a tab that has gone', async () => {
    await expect(refreshBadge(999)).resolves.toBeUndefined();
  });
});

describe('refreshAllBadges', () => {
  it('updates every open tab', async () => {
    addTab(2, 'https://acme.example/x');
    addTab(3, 'https://staging.acme.example/x');
    addTab(4, 'https://unrelated.example/x');

    await refreshAllBadges();

    expect(badge(2)?.text).toBe('PRD');
    expect(badge(3)?.text).toBe('STG');
    expect(badge(4)?.text).toBe('');
  });
});
