import { describe, expect, it } from 'vitest';
import {
  claimedLoopbackPorts,
  findCollisions,
  loopbackClaims,
  suggestLoopbackPort,
  whoClaimsPort,
} from '../../src/core/ports';
import { groupWith } from '../helpers/groups';


const group = groupWith;

const storefront = group('a', 'Storefront', {
  local: 'http://localhost:3000',
  staging: 'https://staging.acme.com',
  prod: 'https://acme.com',
});

const dashboard = group('b', 'Dashboard', {
  local: 'http://localhost:4200',
  prod: 'https://dash.acme.com',
});

describe('loopbackClaims', () => {
  it('lists loopback ports across all groups in ascending order', () => {
    const claims = loopbackClaims([dashboard, storefront]);
    expect(claims.map((c) => c.port)).toEqual([3000, 4200]);
    expect(claims[0]).toMatchObject({ groupTitle: 'Storefront', envKey: 'local', primary: true });
  });

  it('ignores non-loopback environments', () => {
    expect(loopbackClaims([storefront]).every((c) => c.host === 'localhost')).toBe(true);
  });

  it('includes aliases, marked as non-primary', () => {
    const withAlias = group('c', 'Aliased', { local: 'http://localhost:5173' }, (draft) => {
      const local = draft.environments.find((e) => e.key === 'local');
      if (local) local.aliases = ['http://127.0.0.1:5173'];
    });
    const claims = loopbackClaims([withAlias]);
    expect(claims).toHaveLength(2);
    expect(claims.filter((c) => c.primary)).toHaveLength(1);
    expect(claims.find((c) => !c.primary)?.host).toBe('127.0.0.1');
  });

  it('ignores disabled environments', () => {
    const off = group('d', 'Off', { local: 'http://localhost:7777' }, (draft) => {
      const local = draft.environments.find((e) => e.key === 'local');
      if (local) local.enabled = false;
    });
    expect(loopbackClaims([off])).toEqual([]);
  });

  it('treats a bare loopback URL as port 80', () => {
    const bare = group('e', 'Bare', { local: 'http://localhost' });
    expect(loopbackClaims([bare]).map((c) => c.port)).toEqual([80]);
  });
});

describe('claimedLoopbackPorts', () => {
  it('collapses claims into a port set', () => {
    expect([...claimedLoopbackPorts([storefront, dashboard])].sort((a, b) => a - b)).toEqual([
      3000, 4200,
    ]);
  });
});

describe('whoClaimsPort', () => {
  it('names the group holding a port', () => {
    expect(whoClaimsPort([storefront, dashboard], 3000)?.groupTitle).toBe('Storefront');
  });

  it('returns null for a free port', () => {
    expect(whoClaimsPort([storefront, dashboard], 9999)).toBeNull();
  });

  // Without this, editing a group would report the group against itself.
  it('can exclude the group being edited', () => {
    expect(whoClaimsPort([storefront, dashboard], 3000, 'a')).toBeNull();
    expect(whoClaimsPort([storefront, dashboard], 3000, 'b')?.groupTitle).toBe('Storefront');
  });
});

describe('suggestLoopbackPort', () => {
  it('suggests the conventional default when nothing is taken', () => {
    expect(suggestLoopbackPort([])).toBe(3000);
  });

  it('never suggests a port another group already claims', () => {
    const taken = claimedLoopbackPorts([storefront, dashboard]);
    expect(taken.has(suggestLoopbackPort([storefront, dashboard]))).toBe(false);
  });

  it('skips past taken conventional ports', () => {
    expect(suggestLoopbackPort([storefront])).toBe(3001);
  });

  it('honours a preferred port when it is free', () => {
    expect(suggestLoopbackPort([storefront], 8080)).toBe(8080);
  });

  it('ignores a preferred port that is taken', () => {
    expect(suggestLoopbackPort([storefront], 3000)).toBe(3001);
  });

  it('ignores a nonsensical preferred port', () => {
    for (const bad of [0, -1, 70000, 1.5, Number.NaN]) {
      expect(suggestLoopbackPort([], bad)).toBe(3000);
    }
  });

  it('falls back to scanning when every conventional port is taken', () => {
    const hogs = [3000, 3001, 4200, 5173, 5174, 8000, 8080, 8081, 8888, 9000].map((port, i) =>
      group(`hog-${i}`, `Hog ${i}`, { local: `http://localhost:${port}` }),
    );
    const suggestion = suggestLoopbackPort(hogs);
    expect(claimedLoopbackPorts(hogs).has(suggestion)).toBe(false);
    expect(suggestion).toBe(3002);
  });
});

describe('findCollisions', () => {
  it('finds nothing when groups are distinct', () => {
    expect(findCollisions([storefront, dashboard])).toEqual([]);
  });

  // Validation blocks creating these, so this is the safety net for config that
  // arrived via import or a sync merge from another machine.
  it('reports a port shared by two groups', () => {
    const clash = group('c', 'Clash', { local: 'http://localhost:3000' });
    const collisions = findCollisions([storefront, clash]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.display).toBe('localhost:3000');
    expect(collisions[0]!.claimants.map((c) => c.groupTitle).sort()).toEqual(['Clash', 'Storefront']);
  });

  it('recognizes the same environment spelled differently', () => {
    const clash = group('c', 'Clash', { prod: 'https://acme.com:443/' });
    expect(findCollisions([storefront, clash])).toHaveLength(1);
  });

  it('detects a collision via an alias', () => {
    const clash = group('c', 'Clash', { prod: 'https://other.example' }, (draft) => {
      const prod = draft.environments.find((e) => e.key === 'prod');
      if (prod) prod.aliases = ['https://acme.com'];
    });
    expect(findCollisions([storefront, clash])).toHaveLength(1);
  });

  it('does not report an in-group duplicate as a cross-group collision', () => {
    // Two environments in one group pointing at the same URL is a separate
    // problem, caught by validateDraft.
    const selfClash = group('c', 'Self', {
      staging: 'https://same.example',
      prod: 'https://same.example',
    });
    expect(findCollisions([selfClash])).toEqual([]);
  });

  it('ignores disabled environments', () => {
    const clash = group('c', 'Clash', { local: 'http://localhost:3000' }, (draft) => {
      const local = draft.environments.find((e) => e.key === 'local');
      if (local) local.enabled = false;
    });
    expect(findCollisions([storefront, clash])).toEqual([]);
  });

  it('handles an empty config', () => {
    expect(findCollisions([])).toEqual([]);
  });
});
