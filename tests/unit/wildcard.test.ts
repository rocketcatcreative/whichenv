/**
 * Wildcard hosts, end to end at the unit level.
 *
 * A dedicated file rather than additions to url/match/schema, because the property that
 * matters most is a relationship BETWEEN those modules: an exact host always beats a
 * wildcard, and a wildcard match has to arrive downstream pinned to the host the tab is
 * really on. Split across three files, nothing would state either rule.
 */

import { describe, expect, it } from 'vitest';
import {
  concreteBase,
  hostUnderWildcard,
  isWildcardHost,
  parseBaseUrl,
  wildcardIssue,
} from '../../src/core/url';
import { buildIndex, findMatch, lookup, switchTargets } from '../../src/core/match';
import { validateDraft } from '../../src/core/schema';
import { matchPatternsFor } from '../../src/core/permissions';
import { draftWith, groupWith } from '../helpers/groups';

/** The shape this feature exists for: unpredictable preview hostnames. */
const previewGroup = () =>
  groupWith('acme', 'Acme', {
    preview: 'https://*.preview.acme.dev',
    staging: 'https://staging.acme.dev',
    prod: 'https://acme.dev',
  });

describe('parsing a wildcard host', () => {
  it('keeps the star in the host and exposes the suffix separately', () => {
    const parsed = parseBaseUrl('https://*.preview.acme.dev');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.host).toBe('*.preview.acme.dev');
    expect(parsed.value.wildcardSuffix).toBe('preview.acme.dev');
    expect(parsed.value.normalized).toBe('https://*.preview.acme.dev');
    expect(parsed.value.display).toBe('*.preview.acme.dev');
  });

  // The star is part of the identity. One group may hold both, and they must not collide
  // or overwrite each other in the index.
  it('gives a wildcard a different match key from the bare domain', () => {
    const wild = parseBaseUrl('https://*.acme.dev');
    const exact = parseBaseUrl('https://acme.dev');
    expect(wild.ok && exact.ok).toBe(true);
    if (!wild.ok || !exact.ok) return;
    expect(wild.value.matchKey).not.toBe(exact.value.matchKey);
  });

  /*
   * The trap this feature actually fell into, and the reason the star is stripped before
   * `URL` sees it and put back after.
   *
   * URL implementations do not agree on `*` in a hostname: Chromium percent-encodes it to
   * `%2a`, Node leaves it alone. Reading the host back off the parsed URL therefore worked
   * perfectly in this suite and produced a host literally named `%2a.localhost` in the
   * browser, which matched nothing and read as the feature simply not working.
   *
   * These assertions cannot fail under Node even if the fix is reverted, so they are a
   * statement of the contract rather than a live guard. The live guard is the wildcard block
   * in tests/e2e/switching.mjs, which runs in real Chromium.
   */
  it('never lets a percent-encoded star through, whatever URL does with it', () => {
    for (const input of ['https://*.acme.dev', 'http://*.localhost:3000', '*.preview.acme.dev']) {
      const parsed = parseBaseUrl(input);
      expect(parsed.ok, input).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.host, input).not.toContain('%');
      expect(parsed.value.host.startsWith('*.'), input).toBe(true);
      expect(parsed.value.normalized, input).not.toContain('%');
      expect(parsed.value.wildcardSuffix, input).not.toContain('%');
    }
  });

  it('carries a port and a base path like any other base', () => {
    const parsed = parseBaseUrl('http://*.acme.test:8080/shop');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.port).toBe(8080);
    expect(parsed.value.basePath).toBe('/shop');
    expect(parsed.value.normalized).toBe('http://*.acme.test:8080/shop');
  });

  it('assumes http for a local wildcard and https for a remote one', () => {
    const local = parseBaseUrl('*.acme.localhost');
    const remote = parseBaseUrl('*.preview.acme.dev');
    expect(local.ok && local.value.scheme).toBe('http');
    expect(remote.ok && remote.value.scheme).toBe('https');
  });

  it('offers no loopback aliases for a wildcard', () => {
    // `*.localhost` is a real convention, but 127.0.0.1 has no subdomains, so the
    // counterpart offer would be a suggestion that cannot work.
    const parsed = parseBaseUrl('http://*.localhost:3000');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.wildcardSuffix).toBe('localhost');
  });

  describe('rejecting the shapes people try', () => {
    // `URL` accepts every one of these as a hostname, so nothing rejects them for us.
    const bad: [string, string][] = [
      ['https://**.acme.dev', 'wildcard-shape'],
      ['https://*acme.dev', 'wildcard-shape'],
      ['https://a.*.acme.dev', 'wildcard-shape'],
      ['https://*.acme.*.dev', 'wildcard-shape'],
      ['https://*.192.168.1.10', 'wildcard-ip'],
      ['https://*.dev', 'wildcard-too-broad'],
      ['https://*.com', 'wildcard-too-broad'],
    ];

    for (const [input, code] of bad) {
      it(`rejects ${input}`, () => {
        const parsed = parseBaseUrl(input);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.error.code).toBe(code);
      });
    }

    // The exception to too-broad. These never leave the machine, and a wildcard over
    // them is exactly how a multi-site local setup is addressed.
    it('allows a single-label suffix when it is a local convention', () => {
      for (const input of ['*.localhost', '*.test', '*.local', '*.internal']) {
        expect(parseBaseUrl(`http://${input}:3000`).ok, input).toBe(true);
      }
    });

    it('says which wildcards are legal without parsing', () => {
      expect(isWildcardHost('*.acme.dev')).toBe(true);
      expect(isWildcardHost('acme.dev')).toBe(false);
      expect(wildcardIssue('acme.dev')).toBeNull();
      expect(wildcardIssue('*.acme.dev')).toBeNull();
      expect(wildcardIssue('*.dev')?.code).toBe('wildcard-too-broad');
    });
  });
});

describe('hostUnderWildcard', () => {
  it('covers subdomains at any depth', () => {
    expect(hostUnderWildcard('pr-482.preview.acme.dev', 'preview.acme.dev')).toBe(true);
    expect(hostUnderWildcard('a.b.c.preview.acme.dev', 'preview.acme.dev')).toBe(true);
  });

  // Chrome reads its own `*.example.com` this way, and the host permission we generate IS a
  // Chrome pattern. Matching more narrowly than the permission would be harmless; matching
  // more broadly would mean resolving a tab we then cannot draw on.
  it('covers the bare suffix too, the way a Chrome match pattern does', () => {
    expect(hostUnderWildcard('preview.acme.dev', 'preview.acme.dev')).toBe(true);
  });

  it('does not match on a partial label', () => {
    expect(hostUnderWildcard('notpreview.acme.dev', 'preview.acme.dev')).toBe(false);
    expect(hostUnderWildcard('preview.acme.dev.evil.com', 'preview.acme.dev')).toBe(false);
  });

  it('is case insensitive on the live host', () => {
    expect(hostUnderWildcard('PR-1.Preview.Acme.Dev', 'preview.acme.dev')).toBe(true);
  });
});

describe('the index', () => {
  it('keeps wildcards out of byOrigin, in their own bucket', () => {
    const index = buildIndex([previewGroup()]);
    expect(Object.keys(index.byOrigin).sort()).toEqual([
      'https://acme.dev:443',
      'https://staging.acme.dev:443',
    ]);
    expect(index.wildcards).toHaveLength(1);
    expect(index.wildcards[0]?.base.wildcardSuffix).toBe('preview.acme.dev');
  });

  it('sorts wildcards most specific first, whatever order the groups are in', () => {
    const broad = groupWith('broad', 'Broad', { prod: 'https://*.acme.dev' });
    const narrow = groupWith('narrow', 'Narrow', { prod: 'https://*.preview.acme.dev' });

    for (const groups of [[broad, narrow], [narrow, broad]]) {
      expect(buildIndex(groups).wildcards.map((e) => e.base.wildcardSuffix)).toEqual([
        'preview.acme.dev',
        'acme.dev',
      ]);
    }
  });
});

describe('matching', () => {
  it('resolves an unpredictable preview host', () => {
    const match = findMatch([previewGroup()], 'https://pr-482.preview.acme.dev/checkout?a=1');
    expect(match?.envKey).toBe('preview');
  });

  // The ranking rule, and the reason a wildcard is safe to offer at all.
  it('lets an exact host win over a wildcard that also covers it', () => {
    const match = findMatch([previewGroup()], 'https://staging.acme.dev/checkout');
    expect(match?.envKey).toBe('staging');
  });

  it('prefers an exact host in ANOTHER group over a wildcard in this one', () => {
    const groups = [
      groupWith('a', 'Wild', { prod: 'https://*.acme.dev' }),
      groupWith('b', 'Exact', { prod: 'https://staging.acme.dev' }),
    ];
    // Both orders, because "exact first" must be structural rather than a side effect of
    // which group happens to be stored first.
    expect(findMatch(groups, 'https://staging.acme.dev/')?.group.id).toBe('b');
    expect(findMatch([...groups].reverse(), 'https://staging.acme.dev/')?.group.id).toBe('b');
  });

  // Regression guard on a real trap: the old lookup returned null as soon as an origin had
  // candidates, so an origin present with a non-matching base path would have blocked the
  // wildcard tier entirely.
  it('falls through to wildcards when an exact origin exists but its base path does not match', () => {
    const groups = [
      groupWith('a', 'Shop', { prod: 'https://acme.dev/shop' }),
      groupWith('b', 'Wild', { prod: 'https://*.acme.dev' }),
    ];
    expect(findMatch(groups, 'https://acme.dev/blog')?.group.id).toBe('b');
    expect(findMatch(groups, 'https://acme.dev/shop/x')?.group.id).toBe('a');
  });

  it('picks the most specific wildcard', () => {
    const groups = [
      groupWith('broad', 'Broad', { prod: 'https://*.acme.dev' }),
      groupWith('narrow', 'Narrow', { prod: 'https://*.preview.acme.dev' }),
    ];
    expect(findMatch(groups, 'https://pr-1.preview.acme.dev/')?.group.id).toBe('narrow');
    expect(findMatch(groups, 'https://other.acme.dev/')?.group.id).toBe('broad');
  });

  it('keeps the port exact', () => {
    const groups = [groupWith('a', 'A', { local: 'http://*.acme.test:3000' })];
    expect(findMatch(groups, 'http://one.acme.test:3000/')).not.toBeNull();
    expect(findMatch(groups, 'http://one.acme.test:3001/')).toBeNull();
  });

  it('respects a wildcard base path', () => {
    const groups = [groupWith('a', 'A', { prod: 'https://*.acme.dev/shop' })];
    expect(findMatch(groups, 'https://x.acme.dev/shop/items')).not.toBeNull();
    expect(findMatch(groups, 'https://x.acme.dev/blog')).toBeNull();
    // Segment aware, same as an exact base path: /shopping is not under /shop.
    expect(findMatch(groups, 'https://x.acme.dev/shopping')).toBeNull();
  });

  it('does not match a different scheme', () => {
    const groups = [groupWith('a', 'A', { prod: 'https://*.acme.dev' })];
    expect(findMatch(groups, 'http://x.acme.dev/')).toBeNull();
  });
});

describe('a wildcard match downstream', () => {
  // The crux of the whole design. Translation requires from.origin to equal the tab's real
  // origin, so a wildcard entry has to arrive pinned to the host that actually matched.
  it('arrives pinned to the host the tab is really on', () => {
    const index = buildIndex([previewGroup()]);
    const entry = lookup(index, 'https://pr-482.preview.acme.dev/checkout');
    expect(entry?.base.host).toBe('pr-482.preview.acme.dev');
    expect(entry?.base.wildcardSuffix).toBeUndefined();
    expect(entry?.origin).toBe('https://pr-482.preview.acme.dev:443');
  });

  it('switches away from a preview host, keeping the path and query', () => {
    const url = 'https://pr-482.preview.acme.dev/checkout?step=2#pay';
    const match = findMatch([previewGroup()], url);
    expect(match).not.toBeNull();
    if (!match) return;

    const targets = switchTargets(match, url);
    expect(targets.map((t) => t.envKey).sort()).toEqual(['prod', 'staging']);
    expect(targets.find((t) => t.envKey === 'prod')?.url).toBe(
      'https://acme.dev/checkout?step=2#pay',
    );
  });

  // There is no way to know which host `*.preview.acme.dev` meant, so a row for it would
  // either do nothing or navigate to a literal asterisk.
  it('is never offered as somewhere to switch TO', () => {
    const url = 'https://staging.acme.dev/checkout';
    const match = findMatch([previewGroup()], url);
    expect(match).not.toBeNull();
    if (!match) return;
    expect(switchTargets(match, url).map((t) => t.envKey)).toEqual(['prod']);
  });

  it('leaves the base path intact when switching off a wildcard that has one', () => {
    const groups = [
      groupWith('a', 'A', {
        preview: 'https://*.preview.acme.dev/shop',
        prod: 'https://acme.dev/store',
      }),
    ];
    const url = 'https://pr-9.preview.acme.dev/shop/items/3';
    const match = findMatch(groups, url);
    expect(match).not.toBeNull();
    if (!match) return;
    expect(switchTargets(match, url)[0]?.url).toBe('https://acme.dev/store/items/3');
  });

  it('concreteBase leaves a non-wildcard base untouched', () => {
    const parsed = parseBaseUrl('https://acme.dev/shop');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(concreteBase(parsed.value, 'other.example')).toBe(parsed.value);
  });
});

describe('validation', () => {
  const codes = (draft: Parameters<typeof validateDraft>[0]) =>
    validateDraft(draft).issues.map((issue) => issue.code);

  it('accepts a wildcard alongside fixed environments', () => {
    const draft = draftWith('a', 'Acme', {
      preview: 'https://*.preview.acme.dev',
      staging: 'https://staging.acme.dev',
      prod: 'https://acme.dev',
    });
    expect(validateDraft(draft).canSave).toBe(true);
  });

  it('warns that a wildcard cannot be switched into, without blocking', () => {
    const draft = draftWith('a', 'Acme', {
      preview: 'https://*.preview.acme.dev',
      prod: 'https://acme.dev',
    });
    const result = validateDraft(draft);
    expect(result.canSave).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain('wildcard-not-a-target');
    expect(
      result.issues.find((i) => i.code === 'wildcard-not-a-target')?.severity,
    ).toBe('warning');
  });

  // The state a wildcard group falls into by accident: the pill shows, the list is empty.
  it('warns when only one environment is a real destination', () => {
    expect(
      codes(
        draftWith('a', 'Acme', {
          preview: 'https://*.preview.acme.dev',
          qa: 'https://*.qa.acme.dev',
          prod: 'https://acme.dev',
        }),
      ),
    ).toContain('one-switch-target');
  });

  it('warns when nothing at all can be switched to', () => {
    expect(
      codes(
        draftWith('a', 'Acme', {
          preview: 'https://*.preview.acme.dev',
          qa: 'https://*.qa.acme.dev',
        }),
      ),
    ).toContain('no-switch-target');
  });

  it('says nothing about switch targets when every environment has a fixed URL', () => {
    const result = codes(
      draftWith('a', 'Acme', {
        staging: 'https://staging.acme.dev',
        prod: 'https://acme.dev',
      }),
    );
    expect(result).not.toContain('one-switch-target');
    expect(result).not.toContain('no-switch-target');
  });

  it('blocks a malformed wildcard with the parse error', () => {
    const draft = draftWith('a', 'Acme', {
      preview: 'https://*.dev',
      prod: 'https://acme.dev',
    });
    const result = validateDraft(draft);
    expect(result.canSave).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('wildcard-too-broad');
  });

  it('still blocks two groups claiming the identical wildcard', () => {
    const mine = draftWith('a', 'Mine', { preview: 'https://*.preview.acme.dev' });
    const theirs = {
      id: 'b',
      title: 'Theirs',
      matchKeys: ['https://*.preview.acme.dev:443'],
    };
    expect(validateDraft(mine, [theirs]).issues.map((i) => i.code)).toContain('collision');
  });

  // Not a collision. The exact wins, deterministically, in both directions, so this is a
  // legitimate and useful setup rather than an ambiguity.
  it('does not treat a wildcard and an exact host it covers as a collision', () => {
    const mine = draftWith('a', 'Mine', { preview: 'https://*.acme.dev' });
    const theirs = { id: 'b', title: 'Theirs', matchKeys: ['https://staging.acme.dev:443'] };
    expect(validateDraft(mine, [theirs]).issues.map((i) => i.code)).not.toContain('collision');
  });
});

describe('host permissions', () => {
  // Free, because a Chrome match pattern already accepts this syntax and reads it the same
  // way. Worth a test precisely because it is free: nothing would notice if it stopped.
  it('turns a wildcard host into a Chrome subdomain pattern', () => {
    expect(matchPatternsFor(previewGroup())).toEqual([
      'https://*.preview.acme.dev/*',
      'https://acme.dev/*',
      'https://staging.acme.dev/*',
    ]);
  });

  it('drops the port, so one pattern covers a wildcard on any port', () => {
    const group = groupWith('a', 'A', { local: 'http://*.acme.test:3000' });
    expect(matchPatternsFor(group)).toEqual(['http://*.acme.test/*']);
  });
});
