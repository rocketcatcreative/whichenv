import { describe, expect, it } from 'vitest';
import {
  itemId,
  linkMenuItems,
  parseItemId,
  titleFor,
  MENU_ACTIONS,
} from '../../src/core/menu';
import { groupWith } from '../helpers/groups';


const group = groupWith;

const acme = group('acme', 'Acme Storefront', {
  local: 'http://localhost:3000',
  staging: 'https://staging.acme.example',
  prod: 'https://acme.example',
});

describe('itemId and parseItemId', () => {
  it('round trips every action', () => {
    for (const action of MENU_ACTIONS) {
      expect(parseItemId(itemId(action, 'acme', 'prod'))).toEqual({
        action,
        groupId: 'acme',
        envKey: 'prod',
      });
    }
  });

  it('rejects ids that are not ours, so other extensions’ menus are ignored', () => {
    expect(parseItemId('something-else')).toBeNull();
    expect(parseItemId('open-link-on')).toBeNull();
    expect(parseItemId('open-link-on:acme')).toBeNull();
    expect(parseItemId('other:acme:prod')).toBeNull();
    expect(parseItemId('')).toBeNull();
  });

  // The verb comes first so a list of eight rows scans, and the two actions can never read
  // the same way for the same environment.
  it('labels each action distinctly, verb first', () => {
    expect(titleFor('open-link-on', 'Production')).toBe('Open on Production');
    expect(titleFor('copy-link-for', 'Production')).toBe('Copy Production link');
    expect(titleFor('open-link-on', 'Local', 'Alpha')).toBe('Open on Local (Alpha)');
    expect(titleFor('copy-link-for', 'Local', 'Alpha')).toBe('Copy Local link (Alpha)');
  });
});

describe('linkMenuItems', () => {
  it('has nothing to offer with no groups', () => {
    expect(linkMenuItems([])).toEqual([]);
  });

  it('offers one item per enabled environment, per action', () => {
    const items = linkMenuItems([acme]);
    for (const action of MENU_ACTIONS) {
      expect(
        items.filter((item) => item.action === action).map((item) => item.envKey),
        action,
      ).toEqual(['local', 'staging', 'prod']);
    }
  });

  it('covers both opening and copying', () => {
    expect(new Set(linkMenuItems([acme]).map((item) => item.action))).toEqual(
      new Set(MENU_ACTIONS),
    );
  });

  it('orders them lowest risk first, matching the switcher list', () => {
    const shuffled = group('x', 'X', {
      prod: 'https://x.example',
      local: 'http://localhost:4000',
      dev: 'https://dev.x.example',
    });
    expect(
      linkMenuItems([shuffled])
        .filter((item) => item.action === 'open-link-on')
        .map((item) => item.envKey),
    ).toEqual(['local', 'dev', 'prod']);
  });

  it('skips a disabled environment', () => {
    const partial = group('p', 'P', { local: 'http://localhost:5000' });
    expect(new Set(linkMenuItems([partial]).map((item) => item.envKey))).toEqual(
      new Set(['local']),
    );
  });

  it('skips a group with no usable origins entirely', () => {
    expect(linkMenuItems([group('empty', 'Empty', {})])).toEqual([]);
  });

  it('honours a renamed environment', () => {
    const renamed = group('r', 'R', { staging: 'https://s.example' }, (draft) => {
      const env = draft.environments.find((candidate) => candidate.key === 'staging');
      if (env) env.label = 'UAT';
    });
    expect(linkMenuItems([renamed]).map((item) => item.title)).toEqual([
      'Open on UAT',
      'Copy UAT link',
    ]);
  });

  // The menu filters on the LINK's URL, which is what makes a pre-registered menu usable.
  it('targets the group’s own origins, loopback included', () => {
    const patterns = linkMenuItems([acme])[0]?.targetUrlPatterns ?? [];
    expect(patterns).toContain('http://localhost/*');
    expect(patterns).toContain('https://acme.example/*');
    expect(patterns).toContain('https://staging.acme.example/*');
  });

  it('gives every environment of a group the same patterns', () => {
    const items = linkMenuItems([acme]);
    const first = JSON.stringify(items[0]?.targetUrlPatterns);
    for (const item of items) expect(JSON.stringify(item.targetUrlPatterns)).toBe(first);
  });

  it('keeps titles bare when only one group can match a link', () => {
    const other = group('other', 'Other Site', { prod: 'https://other.example' });
    for (const item of linkMenuItems([acme, other])) {
      expect(item.title).not.toContain('(');
    }
  });

  // A match pattern cannot express a port, so two groups on different localhost ports both
  // show up for a localhost link. Without the group name you would see "Local" twice.
  it('adds the group title when two groups share a host', () => {
    const alpha = group('a', 'Alpha', { local: 'http://localhost:3000' });
    const beta = group('b', 'Beta', { local: 'http://localhost:3001' });
    const titles = linkMenuItems([alpha, beta])
      .filter((item) => item.action === 'open-link-on')
      .map((item) => item.title);
    expect(titles).toEqual(['Open on Local (Alpha)', 'Open on Local (Beta)']);
  });

  it('leaves a non-overlapping group bare even when another pair overlaps', () => {
    const alpha = group('a', 'Alpha', { local: 'http://localhost:3000' });
    const beta = group('b', 'Beta', { local: 'http://localhost:3001' });
    const solo = group('s', 'Solo', { prod: 'https://solo.example' });
    const titles = linkMenuItems([alpha, beta, solo])
      .filter((item) => item.action === 'open-link-on')
      .map((item) => item.title);
    expect(titles).toEqual([
      'Open on Local (Alpha)',
      'Open on Local (Beta)',
      'Open on Production',
    ]);
  });

  // A bare glyph in a context menu is a puzzle: there is no tooltip to explain it, and it
  // promised a confirmation this path does not ask for. The guard still applies everywhere
  // it can actually be honoured.
  it('does not decorate a guarded environment, and does not hide it either', () => {
    const guarded = group('g', 'G', { prod: 'https://g.example' }, (draft) => {
      const env = draft.environments.find((candidate) => candidate.key === 'prod');
      if (env) env.confirmOnEnter = true;
    });
    const items = linkMenuItems([guarded]);
    expect(items).toHaveLength(MENU_ACTIONS.length);
    expect(items.map((item) => item.title)).toEqual([
      'Open on Production',
      'Copy Production link',
    ]);
  });

  it('gives every item a unique id', () => {
    const other = group('other', 'Other', { prod: 'https://other.example' });
    const ids = linkMenuItems([acme, other]).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
