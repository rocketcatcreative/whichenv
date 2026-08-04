import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  SCHEMA_VERSION,
  availableEnvKeys,
  removedEnvironment,
  displayLabel,
  draftToGroup,
  emptyDraft,
  groupToDraft,
  issuesByPath,
  matchKeysForEnvironment,
  newEnvironmentDraft,
  normalizeGroup,
  suggestedAliases,
  summarize,
  validateDraft,
  type EnvGroup,
  type GroupDraft,
} from '../../src/core/schema';
import { draftWith } from '../helpers/groups';

const NOW = 1_700_000_000_000;

function draft(overrides: Partial<GroupDraft> = {}): GroupDraft {
  return { ...emptyDraft('group-1'), title: 'Acme Storefront', ...overrides };
}

/**
 * A draft with the four common environments filled in with sane URLs.
 *
 * Built from the URL map rather than from whatever `emptyDraft` happens to contain. Most tests
 * below index into `environments[0..3]`, so what matters is that those four exist in pipeline
 * order, not that a blank group starts that way. It no longer does.
 */
function filledDraft(overrides: Partial<GroupDraft> = {}): GroupDraft {
  const base = draftWith('group-1', 'Acme Storefront', {
    local: 'http://localhost:3000',
    dev: 'https://dev.acme.com',
    staging: 'https://staging.acme.com',
    prod: 'https://acme.com',
  });
  return { ...base, ...overrides };
}

const errorCodes = (d: GroupDraft, others: Parameters<typeof validateDraft>[1] = []) =>
  validateDraft(d, others)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);

const warningCodes = (d: GroupDraft, others: Parameters<typeof validateDraft>[1] = []) =>
  validateDraft(d, others)
    .issues.filter((i) => i.severity === 'warning')
    .map((i) => i.code);

describe('emptyDraft', () => {
  it('starts with production alone', () => {
    expect(emptyDraft('x').environments.map((e) => e.key)).toEqual(['prod']);
  });

  // The reasoning, so a future change has to argue with it: four prefilled rows made a new
  // group look like a form to complete, and most sites do not have all four. Everything else
  // is an add-button, and create-from-tab still prefills the four it can guess.
  it('leaves every other environment to be added deliberately', () => {
    expect(availableEnvKeys(emptyDraft('x')).sort()).toEqual(
      ['dev', 'local', 'preview', 'qa', 'staging'],
    );
  });

  it('starts with no guard enabled anywhere', () => {
    // Per the design: the enter guard is opt in, off by default, on every
    // environment including prod.
    expect(emptyDraft('x').environments.every((e) => e.confirmOnEnter === false)).toBe(true);
  });

  // Not 'off'. A new group pinned to off would be immune to the global default, so
  // switching frames on for everything would visibly skip every group made before the
  // day you switched it, which reads as a bug rather than a setting.
  it('defers both page markers to the global default', () => {
    expect(emptyDraft('x').frame).toBe('default');
    expect(emptyDraft('x').tabIcon).toBe('default');
  });
});

describe('validateDraft', () => {
  it('accepts a fully filled group', () => {
    const result = validateDraft(filledDraft());
    expect(result.issues).toEqual([]);
    expect(result.canSave).toBe(true);
  });

  it('requires a title', () => {
    expect(errorCodes(filledDraft({ title: '' }))).toContain('required');
    expect(errorCodes(filledDraft({ title: '   ' }))).toContain('required');
  });

  it('accepts a missing description', () => {
    expect(errorCodes(filledDraft({ description: '' }))).toEqual([]);
  });

  it('bounds title and description length', () => {
    expect(errorCodes(filledDraft({ title: 'a'.repeat(LIMITS.titleMax + 1) }))).toContain('too-long');
    expect(
      errorCodes(filledDraft({ description: 'a'.repeat(LIMITS.descriptionMax + 1) })),
    ).toContain('too-long');
  });

  it('requires a base URL for an enabled environment', () => {
    const d = filledDraft();
    d.environments[0]!.baseUrl = '';
    expect(errorCodes(d)).toContain('required');
  });

  it('ignores a disabled environment with no base URL', () => {
    const d = filledDraft();
    d.environments[0]!.baseUrl = '';
    d.environments[0]!.enabled = false;
    expect(errorCodes(d)).toEqual([]);
  });

  it('rejects an unparseable base URL', () => {
    const d = filledDraft();
    d.environments[1]!.baseUrl = 'ftp://nope.example';
    expect(errorCodes(d)).toContain('unsupported-scheme');
  });

  it('rejects the same environment key twice', () => {
    const d = filledDraft();
    d.environments.push({ ...newEnvironmentDraft('prod'), baseUrl: 'https://other.example' });
    expect(errorCodes(d)).toContain('duplicate-key');
  });

  // ------------------------------------------------------------------ ports
  describe('ports', () => {
    it('warns when a loopback base URL has no explicit port', () => {
      const d = filledDraft();
      d.environments[0]!.baseUrl = 'http://localhost';
      expect(warningCodes(d)).toContain('loopback-without-port');
      // A warning, not an error: it is legal, just very likely a mistake.
      expect(validateDraft(d).canSave).toBe(true);
    });

    it('does not warn when the port is spelled out, even if it is 80', () => {
      const d = filledDraft();
      d.environments[0]!.baseUrl = 'http://localhost:80';
      expect(warningCodes(d)).not.toContain('loopback-without-port');
    });

    it('does not warn for non-loopback hosts without a port', () => {
      expect(warningCodes(filledDraft())).not.toContain('loopback-without-port');
    });

    it('lets two groups use localhost on different ports', () => {
      const other = summarize(
        draftToGroup(
          filledDraft({ id: 'other', title: 'Other' }),
          NOW,
        ),
      );
      const d = filledDraft({ id: 'mine' });
      d.environments[0]!.baseUrl = 'http://localhost:3001';
      d.environments[1]!.baseUrl = 'https://dev.other.example';
      d.environments[2]!.baseUrl = 'https://staging.other.example';
      d.environments[3]!.baseUrl = 'https://other.example';
      expect(errorCodes(d, [other])).toEqual([]);
    });

    it('blocks two groups from using the same localhost port', () => {
      const other = summarize(draftToGroup(filledDraft({ id: 'other', title: 'Other' }), NOW));
      const d = filledDraft({ id: 'mine' });
      d.environments[1]!.baseUrl = 'https://dev.other.example';
      d.environments[2]!.baseUrl = 'https://staging.other.example';
      d.environments[3]!.baseUrl = 'https://other.example';
      // environments[0] is still http://localhost:3000, same as `other`.
      const issues = validateDraft(d, [other]).issues;
      expect(issues.map((i) => i.code)).toContain('collision');
      expect(issues.find((i) => i.code === 'collision')?.message).toContain('Other');
      expect(validateDraft(d, [other]).canSave).toBe(false);
    });

    it('treats implicit and explicit default ports as the same claim', () => {
      const otherDraft = filledDraft({ id: 'other', title: 'Other' });
      otherDraft.environments[3]!.baseUrl = 'https://acme.com:443';
      const other = summarize(draftToGroup(otherDraft, NOW));

      const d = filledDraft({ id: 'mine' });
      d.environments[0]!.baseUrl = 'http://localhost:9999';
      d.environments[1]!.baseUrl = 'https://dev.mine.example';
      d.environments[2]!.baseUrl = 'https://staging.mine.example';
      // Spelled without the port, but the same environment as the other group's.
      d.environments[3]!.baseUrl = 'https://acme.com';
      expect(errorCodes(d, [other])).toContain('collision');
    });
  });

  // --------------------------------------------------------------- in-group
  it('rejects two environments in one group pointing at the same URL', () => {
    const d = filledDraft();
    d.environments[2]!.baseUrl = 'https://acme.com';
    expect(errorCodes(d)).toContain('duplicate-in-group');
  });

  it('reports the same URL spelled differently as a duplicate', () => {
    const d = filledDraft();
    d.environments[2]!.baseUrl = 'https://acme.com/';
    expect(errorCodes(d)).toContain('duplicate-in-group');
  });

  it('rejects an alias that collides with another environment in the group', () => {
    const d = filledDraft();
    d.environments[1]!.aliases = ['https://acme.com'];
    expect(errorCodes(d)).toContain('duplicate-in-group');
  });

  it('rejects an empty or unparseable alias', () => {
    const d = filledDraft();
    d.environments[0]!.aliases = [''];
    expect(errorCodes(d)).toContain('empty-alias');

    const d2 = filledDraft();
    d2.environments[0]!.aliases = ['ftp://x.example'];
    expect(errorCodes(d2)).toContain('unsupported-scheme');
  });

  it('does not treat a group as colliding with itself when editing', () => {
    const group = draftToGroup(filledDraft({ id: 'mine' }), NOW);
    const peers = [summarize(group)].filter((p) => p.id !== 'mine');
    expect(errorCodes(groupToDraft(group), peers)).toEqual([]);
  });

  it('ignores disabled environments when checking collisions', () => {
    const otherDraft = filledDraft({ id: 'other', title: 'Other' });
    otherDraft.environments[0]!.enabled = false;
    const other = summarize(draftToGroup(otherDraft, NOW));

    const d = filledDraft({ id: 'mine' });
    d.environments[1]!.baseUrl = 'https://dev.mine.example';
    d.environments[2]!.baseUrl = 'https://staging.mine.example';
    d.environments[3]!.baseUrl = 'https://mine.example';
    expect(errorCodes(d, [other])).toEqual([]);
  });

  // ------------------------------------------------------------- usefulness
  it('warns, but allows saving, when only one environment is usable', () => {
    const d = draft();
    d.environments = [{ ...newEnvironmentDraft('prod'), baseUrl: 'https://acme.com' }];
    expect(warningCodes(d)).toContain('nothing-to-switch-to');
    expect(validateDraft(d).canSave).toBe(true);
  });

  it('warns when no environment is usable yet', () => {
    expect(warningCodes(draft())).toContain('none-usable');
  });

  it('points every issue at a specific field path', () => {
    const d = filledDraft({ title: '' });
    d.environments[2]!.baseUrl = 'ftp://x.example';
    const paths = validateDraft(d).issues.map((i) => i.path);
    expect(paths).toContain('title');
    expect(paths).toContain('environments.2.baseUrl');
  });
});

describe('draftToGroup', () => {
  it('stores canonical normalized URLs, not raw input', () => {
    const d = filledDraft();
    d.environments[3]!.baseUrl = '  ACME.com/shop/  ';
    const group = draftToGroup(d, NOW);
    expect(group.environments[3]!.baseUrl).toBe('https://acme.com/shop');
  });

  it('omits empty optional fields rather than storing blanks', () => {
    const group = draftToGroup(filledDraft(), NOW);
    expect(group.description).toBeUndefined();
    expect(group.indicator).toBeUndefined();
    for (const env of group.environments) {
      expect(env.label).toBeUndefined();
      expect(env.aliases).toBeUndefined();
      expect(env.confirmOnEnter).toBeUndefined();
    }
  });

  it('keeps optional fields that were set', () => {
    const d = filledDraft({ description: 'The main storefront', hidden: true });
    d.environments[0]!.label = 'Local dev';
    d.environments[3]!.confirmOnEnter = true;
    const group = draftToGroup(d, NOW);
    expect(group.description).toBe('The main storefront');
    expect(group.indicator).toEqual({ hidden: true });
    expect(group.environments[0]!.label).toBe('Local dev');
    expect(group.environments[3]!.confirmOnEnter).toBe(true);
  });

  // 'default' is the absence of an override, so writing it would put a key in storage
  // that means exactly what leaving it out means, in every group there is.
  it('writes only the page markers that override the default', () => {
    expect(draftToGroup(filledDraft({ frame: 'default' }), NOW).indicator).toBeUndefined();
    expect(draftToGroup(filledDraft({ frame: 'on' }), NOW).indicator).toEqual({ frame: 'on' });
    expect(draftToGroup(filledDraft({ tabIcon: 'off' }), NOW).indicator).toEqual({
      tabIcon: 'off',
    });
    expect(
      draftToGroup(filledDraft({ hidden: true, frame: 'off', tabIcon: 'on' }), NOW).indicator,
    ).toEqual({ hidden: true, frame: 'off', tabIcon: 'on' });
  });

  it('drops an alias identical to its own base URL as redundant', () => {
    const d = filledDraft();
    d.environments[3]!.aliases = ['https://acme.com/', 'https://www.acme.com'];
    const group = draftToGroup(d, NOW);
    expect(group.environments[3]!.aliases).toEqual(['https://www.acme.com']);
  });

  it('dedupes aliases that normalize to the same thing', () => {
    const d = filledDraft();
    d.environments[3]!.aliases = ['https://www.acme.com', 'https://WWW.acme.com/'];
    expect(draftToGroup(d, NOW).environments[3]!.aliases).toEqual(['https://www.acme.com']);
  });

  it('preserves createdAt when updating an existing group', () => {
    const original = draftToGroup(filledDraft(), NOW);
    const updated = draftToGroup(filledDraft({ title: 'Renamed' }), NOW + 5000, original);
    expect(updated.createdAt).toBe(NOW);
    expect(updated.updatedAt).toBe(NOW + 5000);
  });

  it('stamps the schema version', () => {
    expect(draftToGroup(filledDraft(), NOW).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('round trips through groupToDraft without loss', () => {
    const d = filledDraft({
      description: 'desc',
      hidden: true,
      frame: 'on',
      tabIcon: 'off',
    });
    d.environments[0]!.label = 'Local';
    d.environments[0]!.aliases = ['http://127.0.0.1:3000'];
    d.environments[3]!.confirmOnEnter = true;

    const group = draftToGroup(d, NOW);
    const again = draftToGroup(groupToDraft(group), NOW, group);
    expect(again).toEqual(group);
  });
});

describe('normalizeGroup', () => {
  const valid = (): EnvGroup => draftToGroup(filledDraft(), NOW);

  it('accepts a group it produced itself', () => {
    const group = valid();
    expect(normalizeGroup(group)).toEqual(group);
  });

  it('rejects values that are not objects', () => {
    for (const input of [null, undefined, 'group', 7, []]) {
      expect(normalizeGroup(input)).toBeNull();
    }
  });

  // The frame and the tab icon used to be per environment. Widening one environment's flag
  // to the whole group is the closest honest reading of what was asked for, and it is
  // visible and one click to undo. Dropping it would silently switch off a marker someone
  // deliberately turned on, which is neither.
  describe('migrating the old per environment markers', () => {
    const legacy = (flags: Record<string, unknown>): EnvGroup | null =>
      normalizeGroup({
        ...valid(),
        environments: [
          { key: 'local', baseUrl: 'http://localhost:3000', enabled: true },
          { key: 'prod', baseUrl: 'https://acme.com', enabled: true, ...flags },
        ],
      });

    it('reads a single environment flag as the group asking for it', () => {
      expect(legacy({ border: true })?.indicator).toEqual({ frame: 'on' });
      expect(legacy({ tabIcon: true })?.indicator).toEqual({ tabIcon: 'on' });
      expect(legacy({ border: true, tabIcon: true })?.indicator).toEqual({
        frame: 'on',
        tabIcon: 'on',
      });
    });

    it('does not invent an override when no environment had one', () => {
      expect(legacy({})?.indicator).toBeUndefined();
      expect(legacy({ border: false, tabIcon: false })?.indicator).toBeUndefined();
    });

    it('strips the flags off the environments themselves', () => {
      const group = legacy({ border: true, tabIcon: true });
      for (const env of group?.environments ?? []) {
        expect('border' in env).toBe(false);
        expect('tabIcon' in env).toBe(false);
      }
    });

    it('keeps hidden alongside a migrated marker', () => {
      const group = normalizeGroup({
        ...valid(),
        indicator: { hidden: true },
        environments: [{ key: 'prod', baseUrl: 'https://acme.com', enabled: true, border: true }],
      });
      expect(group?.indicator).toEqual({ hidden: true, frame: 'on' });
    });

    // Otherwise a stale flag left in the same record would make the group's own switch
    // impossible to turn off: every load would put it back on.
    it('lets the group setting win over a leftover flag', () => {
      const group = normalizeGroup({
        ...valid(),
        indicator: { frame: 'off', tabIcon: 'off' },
        environments: [
          { key: 'prod', baseUrl: 'https://acme.com', enabled: true, border: true, tabIcon: true },
        ],
      });
      expect(group?.indicator).toEqual({ frame: 'off', tabIcon: 'off' });
    });

    it('migrates a flag from an environment that was switched off', () => {
      const group = normalizeGroup({
        ...valid(),
        environments: [
          { key: 'prod', baseUrl: 'https://acme.com', enabled: false, border: true },
        ],
      });
      expect(group?.indicator).toEqual({ frame: 'on' });
    });
  });

  it('keeps the page marker overrides it is given', () => {
    for (const state of ['on', 'off'] as const) {
      const group = normalizeGroup({ ...valid(), indicator: { frame: state, tabIcon: state } });
      expect(group?.indicator).toEqual({ frame: state, tabIcon: state });
    }
  });

  it('drops an explicit default rather than storing it', () => {
    const group = normalizeGroup({
      ...valid(),
      indicator: { frame: 'default', tabIcon: 'default' },
    });
    expect(group?.indicator).toBeUndefined();
  });

  it('rejects a group with no id or no title', () => {
    expect(normalizeGroup({ ...valid(), id: '' })).toBeNull();
    expect(normalizeGroup({ ...valid(), title: '  ' })).toBeNull();
  });

  // Without this, filling in only prod and reopening the editor would silently
  // lose the local/dev/staging rows.
  it('keeps unfilled placeholder rows so the editor does not lose them', () => {
    const d = filledDraft();
    d.environments[0]!.baseUrl = '';
    d.environments[0]!.enabled = false;
    const stored = draftToGroup(d, NOW);
    const reread = normalizeGroup(JSON.parse(JSON.stringify(stored)));
    expect(reread?.environments.map((e) => e.key)).toEqual(['local', 'dev', 'staging', 'prod']);
    expect(reread?.environments[0]!.baseUrl).toBe('');
  });

  // Invariant relied on by the matcher and the switcher.
  it('never leaves an environment enabled without a usable base URL', () => {
    const reread = normalizeGroup({
      id: 'a',
      title: 'A',
      environments: [
        { key: 'prod', baseUrl: 'https://acme.com', enabled: true },
        { key: 'dev', baseUrl: '', enabled: true },
      ],
    });
    expect(reread?.environments.find((e) => e.key === 'dev')?.enabled).toBe(false);
    expect(reread?.environments.find((e) => e.key === 'prod')?.enabled).toBe(true);
  });

  it('drops environments that cannot be salvaged rather than the whole group', () => {
    const group = valid();
    const result = normalizeGroup({
      ...group,
      environments: [
        ...group.environments,
        { key: 'nonsense', baseUrl: 'https://x.example', enabled: true },
        { key: 'preview', baseUrl: 'not a url', enabled: true },
        'not an object',
      ],
    });
    expect(result?.environments.map((e) => e.key)).toEqual(['local', 'dev', 'staging', 'prod']);
  });

  it('drops a duplicate environment key, keeping the first', () => {
    const group = valid();
    const result = normalizeGroup({
      ...group,
      environments: [
        ...group.environments,
        { key: 'prod', baseUrl: 'https://impostor.example', enabled: true },
      ],
    });
    expect(result?.environments.filter((e) => e.key === 'prod')).toHaveLength(1);
    expect(result?.environments.find((e) => e.key === 'prod')?.baseUrl).toBe('https://acme.com');
  });

  it('re-normalizes URLs that were stored in a non-canonical form', () => {
    const group = valid();
    const result = normalizeGroup({
      ...group,
      environments: [{ key: 'prod', baseUrl: 'HTTPS://ACME.com:443/shop/', enabled: true }],
    });
    expect(result?.environments[0]!.baseUrl).toBe('https://acme.com/shop');
  });

  it('clamps over-long strings instead of rejecting them', () => {
    const result = normalizeGroup({
      ...valid(),
      title: 'a'.repeat(500),
      description: 'b'.repeat(1000),
    });
    expect(result?.title).toHaveLength(LIMITS.titleMax);
    expect(result?.description).toHaveLength(LIMITS.descriptionMax);
  });

  it('does not trust non-boolean flags', () => {
    const result = normalizeGroup({
      ...valid(),
      environments: [
        {
          key: 'prod',
          baseUrl: 'https://acme.com',
          enabled: 'yes',
          confirmOnEnter: 1,
        },
      ],
      indicator: { hidden: 'yes', frame: 'maybe', tabIcon: 7 },
    });
    expect(result?.environments[0]!.enabled).toBe(true);
    expect(result?.environments[0]!.confirmOnEnter).toBeUndefined();
    expect(result?.indicator).toBeUndefined();
  });

  it('never throws, whatever it is given', () => {
    for (const input of [{ environments: 'no' }, { id: 'a', title: 'b', environments: [null] }]) {
      expect(() => normalizeGroup(input)).not.toThrow();
    }
  });

  it('is idempotent', () => {
    const once = normalizeGroup(valid());
    expect(normalizeGroup(once)).toEqual(once);
  });
});

describe('helpers', () => {
  it('prefers the label override, falling back to the palette default', () => {
    expect(displayLabel({ key: 'prod' })).toBe('Production');
    expect(displayLabel({ key: 'qa', label: 'UAT' })).toBe('UAT');
    expect(displayLabel({ key: 'qa', label: '   ' })).toBe('QA');
  });

  it('collects match keys from base URL and aliases together, skipping bad ones', () => {
    expect(
      matchKeysForEnvironment({
        baseUrl: 'https://acme.com',
        aliases: ['https://www.acme.com', 'ftp://nope.example', ''],
      }),
    ).toEqual(['https://acme.com:443', 'https://www.acme.com:443']);
  });

  // Single-label hosts are real (docker service names, intranet hosts), so they
  // are accepted, but a bare word is far more often a half-typed domain.
  it('warns about a host with no domain suffix without blocking it', () => {
    const d = filledDraft();
    d.environments[3]!.baseUrl = 'https://acme';
    const result = validateDraft(d);
    expect(result.issues.map((i) => i.code)).toContain('single-label-host');
    expect(result.canSave).toBe(true);
  });

  it('does not warn about missing domain suffix for loopback or IPv6 hosts', () => {
    const d = filledDraft();
    d.environments[0]!.baseUrl = 'http://localhost:3000';
    d.environments[1]!.baseUrl = 'http://[::1]:4000';
    expect(warningCodes(d)).not.toContain('single-label-host');
  });

  it('summarizes only enabled environments', () => {
    const d = filledDraft();
    d.environments[0]!.enabled = false;
    const summary = summarize(draftToGroup(d, NOW));
    expect(summary.matchKeys).not.toContain('http://localhost:3000');
    expect(summary.matchKeys).toContain('https://acme.com:443');
  });

  it('suggests loopback counterparts as aliases', () => {
    expect(suggestedAliases('http://localhost:3000')).toEqual([
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]);
    expect(suggestedAliases('https://acme.com')).toEqual([]);
    expect(suggestedAliases('garbage://x')).toEqual([]);
  });

  // Removing an environment switches it off and keeps its data, so it counts as available
  // again and adding it back restores what was there.
  it('counts a removed environment as available again', () => {
    const d = filledDraft();
    const dev = d.environments.find((env) => env.key === 'dev');
    if (dev) dev.enabled = false;

    expect(availableEnvKeys(d)).toContain('dev');
    expect(removedEnvironment(d, 'dev')?.baseUrl).toBe('https://dev.acme.com');
    // Still present in the draft, so nothing was thrown away.
    expect(d.environments.map((env) => env.key)).toContain('dev');
  });

  it('does not offer an environment that is still switched on', () => {
    expect(availableEnvKeys(filledDraft())).toEqual(['preview', 'qa']);
    expect(removedEnvironment(filledDraft(), 'dev')).toBeUndefined();
  });

  it('offers only the unused environment slots, in pipeline order', () => {
    // Pipeline order matters: these become the add-buttons, and they should read local to
    // production like everything else does.
    expect(availableEnvKeys(emptyDraft('x'))).toEqual([
      'local',
      'dev',
      'staging',
      'preview',
      'qa',
    ]);

    const full = emptyDraft('x');
    for (const key of ['local', 'dev', 'staging', 'preview', 'qa'] as const) {
      full.environments.push(newEnvironmentDraft(key));
    }
    expect(availableEnvKeys(full)).toEqual([]);
  });

  it('groups issues by field path for rendering next to inputs', () => {
    const d = filledDraft({ title: '' });
    const map = issuesByPath(validateDraft(d).issues);
    expect(map.get('title')?.[0]?.code).toBe('required');
  });
});

describe('a removed environment', () => {
  it('never blocks the save, whatever is wrong with it', () => {
    const d = filledDraft();
    const dev = d.environments.find((env) => env.key === 'dev');
    if (dev) {
      dev.enabled = false;
      dev.baseUrl = 'not a url at all';
      dev.label = 'x'.repeat(LIMITS.labelMax + 20);
      dev.aliases = ['also not a url', ''];
    }

    // No field is rendered for it, so an error against it would be unfixable: nothing to
    // correct, and a save button disabled for an invisible reason.
    expect(errorCodes(d)).toEqual([]);
  });

  it('stops claiming its origin, so another group may take it', () => {
    const d = filledDraft();
    const prod = d.environments.find((env) => env.key === 'prod');
    if (prod) prod.enabled = false;

    const group = draftToGroup(d, NOW);
    expect(summarize(group).matchKeys).not.toContain('https://acme.com:443');
    // But the URL is still stored, ready to come back.
    expect(group.environments.find((env) => env.key === 'prod')?.baseUrl).toBe(
      'https://acme.com',
    );
  });

  it('survives a round trip through storage and back into the editor', () => {
    const d = filledDraft();
    const staging = d.environments.find((env) => env.key === 'staging');
    if (staging) staging.enabled = false;

    const reopened = groupToDraft(draftToGroup(d, NOW));
    const again = reopened.environments.find((env) => env.key === 'staging');
    expect(again?.enabled).toBe(false);
    expect(again?.baseUrl).toBe('https://staging.acme.com');
  });
});
