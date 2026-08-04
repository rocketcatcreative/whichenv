import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { navigate } from '../../src/background/navigate';

const URL_A = 'https://acme.example/products/42?x=1';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
});

describe('navigate', () => {
  describe('current tab', () => {
    it('replaces the URL of the originating tab', async () => {
      await navigate({ url: URL_A, mode: 'current', tabId: 1 });
      expect(fake.__tabs.find((tab) => tab.id === 1)?.url).toBe(URL_A);
      expect(fake.__tabs).toHaveLength(1);
    });

    // Happens when a switch is triggered from the popup against a tab that has
    // since closed. Doing nothing would look like a broken click.
    it('falls back to a new tab when there is no originating tab', async () => {
      await navigate({ url: URL_A, mode: 'current', tabId: undefined });
      expect(fake.__tabs).toHaveLength(2);
      expect(fake.__tabs.at(-1)?.url).toBe(URL_A);
    });
  });

  describe('new tab', () => {
    it('opens a new tab and leaves the original alone', async () => {
      await navigate({ url: URL_A, mode: 'newTab', tabId: 1 });
      expect(fake.__tabs).toHaveLength(2);
      expect(fake.__tabs.find((tab) => tab.id === 1)?.url).toBe('about:blank');
      expect(fake.__tabs.at(-1)?.url).toBe(URL_A);
    });

    // openerTabId is what makes Chrome place the new tab next to the one it came
    // from, rather than at the end of the strip.
    it('records the opener so the new tab lands beside its source', async () => {
      await navigate({ url: URL_A, mode: 'newTab', tabId: 1 });
      expect(fake.__tabs.at(-1)?.openerTabId).toBe(1);
    });

    it('opens in the same window when one is given', async () => {
      await navigate({ url: URL_A, mode: 'newTab', tabId: 1, windowId: 10 });
      expect(fake.__tabs.at(-1)?.windowId).toBe(10);
    });

    it('works with no originating tab, just without an opener', async () => {
      await navigate({ url: URL_A, mode: 'newTab' });
      expect(fake.__tabs).toHaveLength(2);
      expect(fake.__tabs.at(-1)?.openerTabId).toBeUndefined();
    });

    it('activates the new tab', async () => {
      await navigate({ url: URL_A, mode: 'newTab', tabId: 1 });
      expect(fake.__tabs.at(-1)?.active).toBe(true);
    });
  });

  describe('new window', () => {
    it('opens a focused window and leaves every tab alone', async () => {
      await navigate({ url: URL_A, mode: 'newWindow', tabId: 1 });
      expect(fake.__windows).toEqual([{ id: 11, url: URL_A, focused: true }]);
      expect(fake.__tabs).toHaveLength(1);
      expect(fake.__tabs[0]?.url).toBe('about:blank');
    });
  });

  it('passes the URL through untouched, since translation already happened', async () => {
    const tricky = 'https://acme.example/a%20b/c?q=1&q=2#frag';
    await navigate({ url: tricky, mode: 'current', tabId: 1 });
    expect(fake.__tabs[0]?.url).toBe(tricky);
  });
});
