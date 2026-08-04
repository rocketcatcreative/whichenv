import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import {
  ALL_URLS,
  STATIC_MATCHES,
  hasAccess,
  isStaticallyCovered,
  missingFor,
  patternFor,
  patternsFor,
  patternsForAll,
  pruneAccess,
  requestAccess,
} from '../../src/core/permissions';
import type { EnvGroup, GroupDraft } from '../../src/core/schema';
import { tryParseBaseUrl } from '../../src/core/url';
import { groupWith, type Urls } from '../helpers/groups';

let fake: FakeChrome;

/** Shared builder, with this file's two-argument shape kept. */
const group = (
  id: string,
  urls: Urls,
  tweak?: (draft: GroupDraft) => void,
): EnvGroup => groupWith(id, id, urls, tweak);

const storefront = group('storefront', {
  local: 'http://localhost:3000',
  staging: 'https://staging.acme.example',
  prod: 'https://acme.example',
});

beforeEach(() => {
  fake = installFakeChrome();
});

describe('patternFor', () => {
  // Chrome treats a portless pattern as all ports, and host permissions are stored
  // per host, so including the port would be both redundant and wrong.
  it('drops the port, because permissions are per host', () => {
    expect(patternFor(tryParseBaseUrl('http://localhost:3000')!)).toBe('http://localhost/*');
    expect(patternFor(tryParseBaseUrl('https://acme.example:8443')!)).toBe('https://acme.example/*');
  });

  it('drops any base path too', () => {
    expect(patternFor(tryParseBaseUrl('https://acme.example/shop')!)).toBe('https://acme.example/*');
  });

  it('keeps the scheme, since http and https are different permissions', () => {
    expect(patternFor(tryParseBaseUrl('http://acme.example')!)).toBe('http://acme.example/*');
    expect(patternFor(tryParseBaseUrl('https://acme.example')!)).toBe('https://acme.example/*');
  });

  // Match patterns have no syntax for IPv6 literals, so requesting one would fail
  // the whole request rather than just that origin.
  it('returns null for an IPv6 literal host', () => {
    expect(patternFor(tryParseBaseUrl('http://[::1]:3000')!)).toBeNull();
  });
});

describe('patternsFor', () => {
  it('excludes loopback hosts, which the manifest already covers', () => {
    expect(patternsFor(storefront)).toEqual([
      'https://acme.example/*',
      'https://staging.acme.example/*',
    ]);
    for (const pattern of STATIC_MATCHES) {
      expect(isStaticallyCovered(pattern)).toBe(true);
    }
  });

  it('includes aliases', () => {
    const aliased = group('aliased', { prod: 'https://acme.example' }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.aliases = ['https://www.acme.example'];
    });
    expect(patternsFor(aliased)).toEqual([
      'https://acme.example/*',
      'https://www.acme.example/*',
    ]);
  });

  it('skips disabled environments', () => {
    const partial = group('partial', {
      staging: 'https://staging.acme.example',
      prod: 'https://acme.example',
    }, (draft) => {
      const staging = draft.environments.find((e) => e.key === 'staging');
      if (staging) staging.enabled = false;
    });
    expect(patternsFor(partial)).toEqual(['https://acme.example/*']);
  });

  it('deduplicates hosts that differ only by port or path', () => {
    const same = group('same', {
      staging: 'https://acme.example:8443',
      prod: 'https://acme.example/shop',
    });
    expect(patternsFor(same)).toEqual(['https://acme.example/*']);
  });

  it('returns nothing for a purely local group, so it never prompts', () => {
    expect(patternsFor(group('local-only', { local: 'http://localhost:3000' }))).toEqual([]);
  });

  it('unions across groups', () => {
    const other = group('other', { prod: 'https://other.example' });
    expect(patternsForAll([storefront, other])).toEqual([
      'https://acme.example/*',
      'https://other.example/*',
      'https://staging.acme.example/*',
    ]);
  });
});

describe('hasAccess', () => {
  it('is true when nothing needs granting', async () => {
    expect(await hasAccess(group('local-only', { local: 'http://localhost:3000' }))).toBe(true);
  });

  it('is false before granting and true after', async () => {
    expect(await hasAccess(storefront)).toBe(false);
    await requestAccess(storefront);
    expect(await hasAccess(storefront)).toBe(true);
  });

  it('is false when only some origins are granted', async () => {
    fake.__granted.add('https://acme.example/*');
    expect(await hasAccess(storefront)).toBe(false);
  });

  it('is true when blanket access was granted', async () => {
    fake.__granted.add(ALL_URLS);
    expect(await hasAccess(storefront)).toBe(true);
  });
});

describe('requestAccess', () => {
  it('asks for exactly the origins the group needs', async () => {
    await requestAccess(storefront);
    expect(fake.__requests).toEqual([
      ['https://acme.example/*', 'https://staging.acme.example/*'],
    ]);
  });

  it('does not prompt at all for a purely local group', async () => {
    expect(await requestAccess(group('local-only', { local: 'http://localhost:3000' }))).toBe(true);
    expect(fake.__requests).toEqual([]);
  });

  it('reports false when the request is declined', async () => {
    fake.__autoGrant = false;
    expect(await requestAccess(storefront)).toBe(false);
    expect(await hasAccess(storefront)).toBe(false);
  });
});

describe('missingFor', () => {
  it('lists only what is still needed', async () => {
    fake.__granted.add('https://acme.example/*');
    expect(await missingFor(storefront)).toEqual(['https://staging.acme.example/*']);
  });

  it('is empty once everything is granted', async () => {
    await requestAccess(storefront);
    expect(await missingFor(storefront)).toEqual([]);
  });
});

describe('pruneAccess', () => {
  it('gives up an origin no group mentions any more', async () => {
    await requestAccess(storefront);
    const dropped = await pruneAccess([]);
    expect(dropped.sort()).toEqual([
      'https://acme.example/*',
      'https://staging.acme.example/*',
    ]);
    expect([...fake.__granted]).toEqual([]);
  });

  it('keeps origins that are still in use', async () => {
    const other = group('other', { prod: 'https://other.example' });
    await requestAccess(storefront);
    await requestAccess(other);

    await pruneAccess([storefront]);
    expect([...fake.__granted].sort()).toEqual([
      'https://acme.example/*',
      'https://staging.acme.example/*',
    ]);
  });

  // Revoking a deliberate blanket grant because a group was deleted would be
  // presumptuous, and it is not ours to take back.
  it('never revokes blanket access', async () => {
    fake.__granted.add(ALL_URLS);
    expect(await pruneAccess([])).toEqual([]);
    expect([...fake.__granted]).toEqual([ALL_URLS]);
  });

  it('does nothing when there is nothing stale', async () => {
    await requestAccess(storefront);
    expect(await pruneAccess([storefront])).toEqual([]);
  });
});
