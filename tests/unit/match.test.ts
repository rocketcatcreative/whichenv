import { describe, expect, it } from 'vitest';
import {
  EMPTY_INDEX,
  buildIndex,
  findMatch,
  lookup,
  resolveMatch,
  switchTargets,
} from '../../src/core/match';
import { newEnvironmentDraft } from '../../src/core/schema';
import { groupWith } from '../helpers/groups';


const group = groupWith;

const storefront = group('sf', 'Storefront', {
  local: 'http://localhost:3000',
  dev: 'https://dev.acme.com',
  staging: 'https://staging.acme.com',
  prod: 'https://acme.com',
});

const dashboard = group('db', 'Dashboard', {
  local: 'http://localhost:4200',
  prod: 'https://dash.acme.com',
});

const ALL = [storefront, dashboard];

describe('buildIndex', () => {
  it('indexes every enabled environment by origin with an explicit port', () => {
    const index = buildIndex([storefront]);
    expect(Object.keys(index.byOrigin).sort()).toEqual([
      'http://localhost:3000',
      'https://acme.com:443',
      'https://dev.acme.com:443',
      'https://staging.acme.com:443',
    ]);
    expect(index.groupCount).toBe(1);
  });

  it('skips disabled environments', () => {
    const off = group('x', 'Off', { prod: 'https://only.example' }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.enabled = false;
    });
    expect(buildIndex([off]).byOrigin).toEqual({});
  });

  it('indexes aliases alongside base URLs, flagged as aliases', () => {
    const aliased = group('x', 'Aliased', { prod: 'https://acme.example' }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.aliases = ['https://www.acme.example'];
    });
    const index = buildIndex([aliased]);
    expect(index.byOrigin['https://acme.example:443']?.[0]?.isAlias).toBe(false);
    expect(index.byOrigin['https://www.acme.example:443']?.[0]?.isAlias).toBe(true);
  });

  it('ignores an alias that does not parse', () => {
    const bad = group('x', 'Bad', { prod: 'https://acme.example' }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.aliases = ['ftp://nope.example'];
    });
    expect(Object.keys(buildIndex([bad]).byOrigin)).toEqual(['https://acme.example:443']);
  });

  it('sorts entries on one origin longest base path first', () => {
    const shop = group('a', 'Shop', { prod: 'https://acme.example/shop' });
    const root = group('b', 'Root', { prod: 'https://acme.example' });
    const deep = group('c', 'Deep', { prod: 'https://acme.example/shop/eu' });

    const entries = buildIndex([root, shop, deep]).byOrigin['https://acme.example:443'] ?? [];
    expect(entries.map((entry) => entry.basePath)).toEqual(['/shop/eu', '/shop', '']);
  });

  it('produces a plain serializable object, so it can be cached in storage.session', () => {
    const index = buildIndex(ALL);
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });

  it('handles an empty config', () => {
    expect(buildIndex([])).toEqual({ byOrigin: {}, wildcards: [], groupCount: 0 });
  });
});

describe('lookup', () => {
  const index = buildIndex(ALL);

  it('finds an exact origin match', () => {
    expect(lookup(index, 'https://acme.com/products/42')?.envKey).toBe('prod');
    expect(lookup(index, 'https://staging.acme.com/')?.envKey).toBe('staging');
  });

  it('ignores the path, query and fragment when there is no base path', () => {
    expect(lookup(index, 'https://acme.com/a/b/c?d=e#f')?.groupId).toBe('sf');
  });

  // The case that matters most for local development.
  it('distinguishes localhost ports', () => {
    expect(lookup(index, 'http://localhost:3000/x')?.groupId).toBe('sf');
    expect(lookup(index, 'http://localhost:4200/x')?.groupId).toBe('db');
    expect(lookup(index, 'http://localhost:9999/x')).toBeNull();
  });

  it('treats an implicit default port as matching an explicit one', () => {
    expect(lookup(index, 'https://acme.com:443/x')?.envKey).toBe('prod');
  });

  it('does not match a different scheme on the same host', () => {
    expect(lookup(index, 'http://acme.com/x')).toBeNull();
  });

  it('is case-insensitive about the host', () => {
    expect(lookup(index, 'https://ACME.com/x')?.envKey).toBe('prod');
  });

  it('returns null for anything that is not http or https', () => {
    for (const url of ['chrome://extensions', 'file:///x', 'about:blank', 'data:,hi']) {
      expect(lookup(index, url)).toBeNull();
    }
  });

  it('returns null for unparseable input and never throws', () => {
    for (const url of ['', 'not a url', '://', '%%%']) {
      expect(() => lookup(index, url)).not.toThrow();
      expect(lookup(index, url)).toBeNull();
    }
  });

  it('returns null against an empty index', () => {
    expect(lookup(EMPTY_INDEX, 'https://acme.com')).toBeNull();
  });

  describe('longest prefix', () => {
    const shop = group('a', 'Shop', { prod: 'https://acme.example/shop' });
    const root = group('b', 'Root', { prod: 'https://acme.example' });
    const nested = buildIndex([root, shop]);

    it('prefers the more specific base path', () => {
      expect(lookup(nested, 'https://acme.example/shop/items')?.groupId).toBe('a');
      expect(lookup(nested, 'https://acme.example/shop')?.groupId).toBe('a');
    });

    it('falls back to the less specific one', () => {
      expect(lookup(nested, 'https://acme.example/admin')?.groupId).toBe('b');
      expect(lookup(nested, 'https://acme.example/')?.groupId).toBe('b');
    });

    // Segment awareness: /shopping belongs to the root group, not the shop group.
    it('does not let a partial segment steal the match', () => {
      expect(lookup(nested, 'https://acme.example/shopping')?.groupId).toBe('b');
    });

    it('returns null when the only entry has a base path the URL is not under', () => {
      expect(lookup(buildIndex([shop]), 'https://acme.example/admin')).toBeNull();
    });
  });
});

describe('resolveMatch and findMatch', () => {
  it('resolves an entry to its group and environment', () => {
    const match = findMatch(ALL, 'http://localhost:3000/x');
    expect(match?.group.title).toBe('Storefront');
    expect(match?.envKey).toBe('local');
    expect(match?.label).toBe('Local');
    expect(match?.matchedViaAlias).toBe(false);
    expect(match?.matchedBase.matchKey).toBe('http://localhost:3000');
  });

  it('reports the alias as the matched base, not the environment base URL', () => {
    // This matters: translation strips the base that actually matched.
    const aliased = group('x', 'Aliased', { prod: 'https://acme.example' }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.aliases = ['https://www.acme.example'];
    });
    const match = findMatch([aliased], 'https://www.acme.example/products/7');
    expect(match?.matchedViaAlias).toBe(true);
    expect(match?.matchedBase.host).toBe('www.acme.example');
  });

  it('honours a label override, including on a spare slot', () => {
    const labelled = group('x', 'Labelled', { prod: 'https://acme.example' }, (draft) => {
      draft.environments.push({
        ...newEnvironmentDraft('qa'),
        baseUrl: 'https://uat.example',
        label: 'UAT',
      });
    });
    expect(findMatch([labelled], 'https://uat.example')?.label).toBe('UAT');
    expect(findMatch([labelled], 'https://acme.example')?.label).toBe('Production');
  });

  it('returns null when the index points at a group that has gone', () => {
    const entry = lookup(buildIndex([storefront]), 'https://acme.com/x');
    expect(entry).not.toBeNull();
    expect(resolveMatch([dashboard], entry!)).toBeNull();
  });

  it('returns null for a URL in no group', () => {
    expect(findMatch(ALL, 'https://unrelated.example/x')).toBeNull();
  });
});

describe('switchTargets', () => {
  it('offers the other environments with translated URLs', () => {
    const match = findMatch(ALL, 'https://staging.acme.com/products/42?ref=x#top')!;
    const targets = switchTargets(match, 'https://staging.acme.com/products/42?ref=x#top');

    expect(targets.map((t) => t.envKey)).toEqual(['local', 'dev', 'prod']);
    expect(targets.find((t) => t.envKey === 'prod')?.url).toBe(
      'https://acme.com/products/42?ref=x#top',
    );
    expect(targets.find((t) => t.envKey === 'local')?.url).toBe(
      'http://localhost:3000/products/42?ref=x#top',
    );
  });

  it('never offers the environment you are already on', () => {
    const match = findMatch(ALL, 'https://acme.com/x')!;
    expect(switchTargets(match, 'https://acme.com/x').map((t) => t.envKey)).not.toContain('prod');
  });

  it('keeps the environments in the group’s own order', () => {
    const match = findMatch(ALL, 'http://localhost:3000/x')!;
    expect(switchTargets(match, 'http://localhost:3000/x').map((t) => t.envKey)).toEqual([
      'dev', 'staging', 'prod',
    ]);
  });

  it('skips disabled environments', () => {
    const partial = group('x', 'Partial', {
      local: 'http://localhost:5555',
      prod: 'https://p.example',
    });
    const match = findMatch([partial], 'http://localhost:5555/x')!;
    expect(switchTargets(match, 'http://localhost:5555/x').map((t) => t.envKey)).toEqual(['prod']);
  });

  it('reports the guard flag so the UI can ask for confirmation', () => {
    const guarded = group('x', 'Guarded', {
      local: 'http://localhost:5556',
      prod: 'https://guarded.example',
    }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.confirmOnEnter = true;
    });
    const match = findMatch([guarded], 'http://localhost:5556/x')!;
    const targets = switchTargets(match, 'http://localhost:5556/x');
    expect(targets[0]?.confirmOnEnter).toBe(true);
  });

  it('translates from the alias that matched, not the canonical base URL', () => {
    const aliased = group('x', 'Aliased', {
      staging: 'https://staging.example',
      prod: 'https://acme.example',
    }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.aliases = ['https://www.acme.example'];
    });

    const current = 'https://www.acme.example/products/7?a=1';
    const match = findMatch([aliased], current)!;
    expect(switchTargets(match, current)[0]?.url).toBe('https://staging.example/products/7?a=1');
  });

  // The switcher list is built from the CURRENT url every time, so a single page
  // app that has changed route since the pill rendered still goes to the right place.
  it('recomputes targets from whatever URL it is given', () => {
    const match = findMatch(ALL, 'https://acme.com/one')!;
    expect(switchTargets(match, 'https://acme.com/two?x=1')[0]?.url).toBe(
      'http://localhost:3000/two?x=1',
    );
  });

  it('omits an environment whose target cannot be computed', () => {
    // A base path on the source that the current URL is not under makes the
    // remainder unresolvable, so the row is dropped rather than offered as a
    // no-op.
    const scoped = group('x', 'Scoped', {
      staging: 'https://staging.example/app',
      prod: 'https://acme.example',
    });
    const match = findMatch([scoped], 'https://acme.example/outside')!;
    const targets = switchTargets(match, 'https://acme.example/outside');
    expect(targets.map((t) => t.envKey)).toEqual(['staging']);
    expect(targets[0]?.url).toBe('https://staging.example/app/outside');
  });

  it('carries a base path across correctly in both directions', () => {
    const scoped = group('x', 'Scoped', {
      local: 'http://localhost:7000',
      prod: 'https://acme.example/shop',
    });

    const fromProd = findMatch([scoped], 'https://acme.example/shop/item/9')!;
    expect(switchTargets(fromProd, 'https://acme.example/shop/item/9')[0]?.url).toBe(
      'http://localhost:7000/item/9',
    );

    const fromLocal = findMatch([scoped], 'http://localhost:7000/item/9')!;
    expect(switchTargets(fromLocal, 'http://localhost:7000/item/9')[0]?.url).toBe(
      'https://acme.example/shop/item/9',
    );
  });
});
