import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import {
  INDEX_KEY,
  QuotaError,
  collisionPeers,
  deleteGroup,
  getGroup,
  groupKey,
  listGroups,
  newGroupId,
  onGroupsChanged,
  reorderGroups,
  saveGroup,
  saveGroups,
  deleteGroups,
} from '../../src/core/storage';
import { draftToGroup, emptyDraft, type EnvGroup } from '../../src/core/schema';

const NOW = 1_700_000_000_000;
let fake: FakeChrome;

function makeGroup(id: string, title: string, prodHost: string, createdAt = NOW): EnvGroup {
  const draft = emptyDraft(id);
  draft.title = title;
  draft.environments = draft.environments.map((env) => ({
    ...env,
    baseUrl: env.key === 'prod' ? `https://${prodHost}` : '',
    enabled: env.key === 'prod',
  }));
  const group = draftToGroup(draft, createdAt);
  return { ...group, createdAt };
}

beforeEach(() => {
  fake = installFakeChrome();
});

describe('storage layout', () => {
  it('writes one key per group plus an ordered index', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await saveGroup(makeGroup('b', 'Beta', 'beta.example'));

    expect([...fake.__data.keys()].sort()).toEqual([INDEX_KEY, 'grp:a', 'grp:b']);
    expect(fake.__data.get(INDEX_KEY)).toEqual(['a', 'b']);
  });

  it('uses a prefixed key name', () => {
    expect(groupKey('abc')).toBe('grp:abc');
  });

  it('generates unique ids', () => {
    expect(newGroupId()).not.toBe(newGroupId());
  });
});

describe('listGroups', () => {
  it('returns an empty list when nothing is stored', async () => {
    expect(await listGroups()).toEqual([]);
  });

  it('returns groups in index order, not insertion order', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await saveGroup(makeGroup('b', 'Beta', 'beta.example'));
    await reorderGroups(['b', 'a']);
    expect((await listGroups()).map((g) => g.title)).toEqual(['Beta', 'Alpha']);
  });

  // Sync can deliver the index and the group keys out of order across machines,
  // so the index is a hint about ordering rather than the authoritative set.
  it('adopts a group that is missing from the index', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await fake.storage.sync.set({ 'grp:orphan': makeGroup('orphan', 'Orphan', 'orphan.example') });

    const groups = await listGroups();
    expect(groups.map((g) => g.id).sort()).toEqual(['a', 'orphan']);
    expect(fake.__data.get(INDEX_KEY)).toEqual(['a', 'orphan']);
  });

  it('drops an index entry whose group no longer exists', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await fake.storage.sync.set({ [INDEX_KEY]: ['a', 'ghost'] });

    expect((await listGroups()).map((g) => g.id)).toEqual(['a']);
    expect(fake.__data.get(INDEX_KEY)).toEqual(['a']);
  });

  it('survives a corrupt index', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await fake.storage.sync.set({ [INDEX_KEY]: 'not an array' });
    expect((await listGroups()).map((g) => g.id)).toEqual(['a']);
  });

  it('skips a stored group that cannot be salvaged', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await fake.storage.sync.set({ 'grp:junk': { nope: true }, [INDEX_KEY]: ['a', 'junk'] });
    expect((await listGroups()).map((g) => g.id)).toEqual(['a']);
  });

  it('orders adopted orphans oldest first, for stable display', async () => {
    await fake.storage.sync.set({
      'grp:new': makeGroup('new', 'Newer', 'new.example', NOW + 1000),
      'grp:old': makeGroup('old', 'Older', 'old.example', NOW),
    });
    expect((await listGroups()).map((g) => g.id)).toEqual(['old', 'new']);
  });

  it('does not rewrite the index when it is already correct', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    const spy = vi.spyOn(fake.storage.sync, 'set');
    await listGroups();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('getGroup', () => {
  it('reads a stored group', async () => {
    const group = makeGroup('a', 'Alpha', 'alpha.example');
    await saveGroup(group);
    expect(await getGroup('a')).toEqual(group);
  });

  it('returns null for an unknown id', async () => {
    expect(await getGroup('nope')).toBeNull();
  });
});

describe('saveGroup', () => {
  it('updates in place without duplicating the index entry', async () => {
    const group = makeGroup('a', 'Alpha', 'alpha.example');
    await saveGroup(group);
    await saveGroup({ ...group, title: 'Renamed' });

    expect(fake.__data.get(INDEX_KEY)).toEqual(['a']);
    expect((await getGroup('a'))?.title).toBe('Renamed');
  });

  // Chrome's own error for this is opaque, so the guard exists to say something
  // actionable instead.
  it('throws a QuotaError with guidance when a group is too large', async () => {
    const group = makeGroup('a', 'Alpha', 'alpha.example');
    const huge: EnvGroup = { ...group, description: 'x'.repeat(9000) };

    await expect(saveGroup(huge)).rejects.toThrow(QuotaError);
    await expect(saveGroup(huge)).rejects.toThrow(/split it into two groups/);
  });

  it('does not write anything when the quota guard trips', async () => {
    const group = makeGroup('a', 'Alpha', 'alpha.example');
    await expect(saveGroup({ ...group, description: 'x'.repeat(9000) })).rejects.toThrow();
    expect(fake.__data.size).toBe(0);
  });

  it('leaves headroom below the hard limit rather than writing right up to it', async () => {
    const group = makeGroup('a', 'Alpha', 'alpha.example');
    // Just under Chrome's 8192 but inside our margin: we refuse, Chrome would not.
    await expect(saveGroup({ ...group, description: 'x'.repeat(8000) })).rejects.toThrow(QuotaError);
  });
});

describe('deleteGroup', () => {
  it('removes the group and its index entry', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await saveGroup(makeGroup('b', 'Beta', 'beta.example'));
    await deleteGroup('a');

    expect(fake.__data.has('grp:a')).toBe(false);
    expect(fake.__data.get(INDEX_KEY)).toEqual(['b']);
    expect((await listGroups()).map((g) => g.id)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await deleteGroup('nope');
    expect((await listGroups()).map((g) => g.id)).toEqual(['a']);
  });
});

describe('reorderGroups', () => {
  it('sets display order', async () => {
    for (const id of ['a', 'b', 'c']) {
      await saveGroup(makeGroup(id, id.toUpperCase(), `${id}.example`));
    }
    await reorderGroups(['c', 'a', 'b']);
    expect((await listGroups()).map((g) => g.id)).toEqual(['c', 'a', 'b']);
  });

  // A stale reorder must not be able to make a group vanish from the UI.
  it('appends any group the caller forgot to mention', async () => {
    for (const id of ['a', 'b', 'c']) {
      await saveGroup(makeGroup(id, id.toUpperCase(), `${id}.example`));
    }
    await reorderGroups(['c']);
    expect((await listGroups()).map((g) => g.id)).toEqual(['c', 'a', 'b']);
  });

  it('ignores ids that do not exist', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await reorderGroups(['ghost', 'a']);
    expect((await listGroups()).map((g) => g.id)).toEqual(['a']);
  });
});

describe('collisionPeers', () => {
  it('summarizes every group', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await saveGroup(makeGroup('b', 'Beta', 'beta.example'));

    const peers = await collisionPeers();
    expect(peers.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(peers.find((p) => p.id === 'a')?.matchKeys).toEqual(['https://alpha.example:443']);
  });

  // Without the exclusion, editing a group reports it as colliding with itself.
  it('excludes the group being edited', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await saveGroup(makeGroup('b', 'Beta', 'beta.example'));
    expect((await collisionPeers('a')).map((p) => p.id)).toEqual(['b']);
  });
});

describe('onGroupsChanged', () => {
  it('fires when a group is written', async () => {
    const seen: number[] = [];
    const stop = onGroupsChanged((groups) => seen.push(groups.length));

    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toBe(1);
    stop();
  });

  it('fires when a group is deleted', async () => {
    await saveGroup(makeGroup('a', 'Alpha', 'alpha.example'));

    const seen: number[] = [];
    const stop = onGroupsChanged((groups) => seen.push(groups.length));
    await deleteGroup('a');
    await vi.waitFor(() => expect(seen.at(-1)).toBe(0));
    stop();
  });

  it('ignores unrelated keys such as settings', async () => {
    const listener = vi.fn();
    const stop = onGroupsChanged(listener);

    await fake.storage.sync.set({ settings: { corner: 'bl' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it('unsubscribes cleanly', async () => {
    const stop = onGroupsChanged(() => {});
    expect(fake.__listenerCount()).toBe(1);
    stop();
    expect(fake.__listenerCount()).toBe(0);
  });
});

/**
 * Batched writes.
 *
 * The reason this exists: importing ten groups a group at a time hit
 * `MAX_WRITE_OPERATIONS_PER_MINUTE` on a real profile and stopped after seven, leaving the
 * user half migrated with no record of which half. Chrome rejects the whole request, so a
 * loop commits everything before the failure and nothing after it.
 */
describe('saveGroups', () => {
  const ten = (): EnvGroup[] =>
    Array.from({ length: 10 }, (_, i) =>
      makeGroup(`g${i}`, `Group ${i}`, `site${i}.example`),
    );

  it('writes any number of groups in a single operation', async () => {
    const before = fake.__writeOps();
    await saveGroups(ten());
    expect(fake.__writeOps() - before).toBe(1);
  });

  it('stores every group and lists them all', async () => {
    await saveGroups(ten());
    const stored = await listGroups();
    expect(stored).toHaveLength(10);
    expect(stored.map((group) => group.title)).toEqual(ten().map((group) => group.title));
  });

  it('survives a write budget that a per-group loop would exhaust', async () => {
    fake.__setWriteLimit(fake.__writeOps() + 1);
    await expect(saveGroups(ten())).resolves.toBeUndefined();
    expect(await listGroups()).toHaveLength(10);
  });

  // The regression that matters. A loop leaves storage half written; a batch leaves it
  // untouched, so the same import can simply be retried once the quota refills.
  it('writes nothing at all when the quota refuses it', async () => {
    fake.__setWriteLimit(fake.__writeOps());
    await expect(saveGroups(ten())).rejects.toThrow(/MAX_WRITE_OPERATIONS_PER_MINUTE/);

    fake.__setWriteLimit(Number.POSITIVE_INFINITY);
    expect(await listGroups()).toHaveLength(0);
  });

  it('appends to an existing index without disturbing what is there', async () => {
    await saveGroup(makeGroup('first', 'First', 'first.example'));
    await saveGroups([makeGroup('a', 'A', 'a.example'), makeGroup('b', 'B', 'b.example')]);
    expect((await listGroups()).map((group) => group.id)).toEqual(['first', 'a', 'b']);
  });

  it('overwrites a group already stored under the same id, without duplicating the index', async () => {
    await saveGroup(makeGroup('a', 'Old name', 'a.example'));
    await saveGroups([makeGroup('a', 'New name', 'a.example')]);

    const stored = await listGroups();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe('New name');
    expect(fake.__data.get(INDEX_KEY)).toEqual(['a']);
  });

  // Checked up front, so an oversized group cannot land the others and then fail.
  it('rejects the whole batch if any group is too large, writing none of it', async () => {
    const fine = makeGroup('a', 'A', 'a.example');
    const huge: EnvGroup = { ...makeGroup('b', 'B', 'b.example'), description: 'x'.repeat(9000) };

    await expect(saveGroups([fine, huge])).rejects.toThrow(QuotaError);
    // Including the one that WOULD have fitted. Checking sizes up front is what makes the
    // failure clean rather than partial.
    expect(await listGroups()).toHaveLength(0);
  });

  it('does nothing for an empty list rather than rewriting the index', async () => {
    await saveGroup(makeGroup('a', 'A', 'a.example'));
    const before = fake.__writeOps();
    await saveGroups([]);
    expect(fake.__writeOps()).toBe(before);
  });
});

describe('deleteGroups', () => {
  it('deletes any number of groups in two operations', async () => {
    await saveGroups([
      makeGroup('a', 'A', 'a.example'),
      makeGroup('b', 'B', 'b.example'),
      makeGroup('c', 'C', 'c.example'),
    ]);

    const before = fake.__writeOps();
    await deleteGroups(['a', 'b', 'c']);
    expect(fake.__writeOps() - before).toBe(2);
    expect(await listGroups()).toHaveLength(0);
  });

  it('leaves groups it was not asked about alone', async () => {
    await saveGroups([makeGroup('a', 'A', 'a.example'), makeGroup('b', 'B', 'b.example')]);
    await deleteGroups(['a']);
    expect((await listGroups()).map((group) => group.id)).toEqual(['b']);
  });

  it('does nothing for an empty list', async () => {
    await saveGroup(makeGroup('a', 'A', 'a.example'));
    const before = fake.__writeOps();
    await deleteGroups([]);
    expect(fake.__writeOps()).toBe(before);
  });
});
