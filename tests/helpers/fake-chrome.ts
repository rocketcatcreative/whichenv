/**
 * A minimal in-memory stand-in for the slice of chrome.* the core modules use.
 *
 * Deliberately hand written rather than mocked with a library: the surface is
 * four methods and an event, and a real implementation catches things a mock does
 * not. In particular it enforces the per-item byte ceiling and fires
 * onChanged with the same shape Chrome does, so the quota guard and the change
 * subscription are exercised for real.
 */

type Listener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

export interface TabRecord {
  id: number;
  url: string;
  windowId: number;
  active?: boolean;
  openerTabId?: number;
  groupId?: number;
}

export interface TabGroupRecord {
  id: number;
  windowId: number;
  title?: string;
  color?: string;
}

export interface BadgeState {
  text?: string;
  background?: string;
  textColor?: string;
  title?: string;
}

export interface MenuRecord {
  id: string;
  title?: string;
  parentId?: string;
  contexts?: string[];
  targetUrlPatterns?: string[];
}

export interface MenuClick {
  menuItemId: string;
  linkUrl?: string;
}

export interface FakeChrome {
  action: {
    setBadgeText: (details: { tabId?: number; text?: string }) => Promise<void>;
    setBadgeBackgroundColor: (details: { tabId?: number; color?: string }) => Promise<void>;
    setBadgeTextColor: (details: { tabId?: number; color?: string }) => Promise<void>;
    setTitle: (details: { tabId?: number; title?: string }) => Promise<void>;
  };
  permissions: {
    getAll: () => Promise<{ permissions: string[]; origins: string[] }>;
    contains: (query: { origins?: string[] }) => Promise<boolean>;
    request: (query: { origins?: string[] }) => Promise<boolean>;
    remove: (query: { origins?: string[] }) => Promise<boolean>;
    onAdded: { addListener: (l: () => void) => void };
    onRemoved: { addListener: (l: () => void) => void };
  };
  scripting: {
    getRegisteredContentScripts: (filter?: { ids?: string[] }) => Promise<
      { id: string; matches?: string[]; js?: string[] }[]
    >;
    registerContentScripts: (
      scripts: { id: string; matches?: string[]; js?: string[] }[],
    ) => Promise<void>;
    updateContentScripts: (
      scripts: { id: string; matches?: string[]; js?: string[] }[],
    ) => Promise<void>;
    unregisterContentScripts: (filter?: { ids?: string[] }) => Promise<void>;
    executeScript: (injection: {
      target: { tabId: number };
      args?: unknown[];
      func: (...args: never[]) => unknown;
    }) => Promise<{ result: unknown }[]>;
  };
  runtime: {
    getManifest: () => { name: string; short_name?: string; version: string };
  };
  contextMenus: {
    create: (props: MenuRecord) => string;
    removeAll: (done?: () => void) => void;
    onClicked: {
      addListener: (listener: (info: MenuClick, tab?: TabRecord) => void) => void;
    };
  };
  tabGroups: {
    TAB_GROUP_ID_NONE: number;
    get: (groupId: number) => Promise<TabGroupRecord>;
    query: (filter: { windowId?: number; title?: string }) => Promise<TabGroupRecord[]>;
    update: (groupId: number, props: { title?: string; color?: string }) => Promise<TabGroupRecord>;
  };
  tabs: {
    update: (tabId: number, props: { url?: string }) => Promise<TabRecord>;
    group: (options: {
      tabIds: number[];
      groupId?: number;
      createProperties?: { windowId?: number };
    }) => Promise<number>;
    create: (props: {
      url?: string;
      openerTabId?: number;
      windowId?: number;
      active?: boolean;
    }) => Promise<TabRecord>;
    query: (info: Record<string, unknown>) => Promise<TabRecord[]>;
    get: (tabId: number) => Promise<TabRecord>;
  };
  windows: {
    create: (props: { url?: string; focused?: boolean }) => Promise<{ id: number }>;
  };
  storage: {
    sync: {
      get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
      clear: () => Promise<void>;
    };
    session: {
      get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
    onChanged: {
      addListener: (listener: Listener) => void;
      removeListener: (listener: Listener) => void;
    };
  };
  /** Test-only helpers, not part of the chrome API. */
  __menus: MenuRecord[];
  /** What executeScript was asked to run, and what it returned. */
  __injections: { tabId: number; args: unknown[]; result: unknown }[];
  /** Set false to make executeScript reject, as a restricted page would. */
  __allowInjection: boolean;
  /** What the injected function is reported to have returned. */
  __injectionResult: unknown;
  /** Fires a context menu click the way Chrome would. */
  __clickMenu: (info: MenuClick, tab?: TabRecord) => void;
  __badges: Map<number, BadgeState>;
  __tabGroups: TabGroupRecord[];
  __session: Map<string, unknown>;
  __granted: Set<string>;
  __scripts: { id: string; matches?: string[]; js?: string[] }[];
  /** Set false to make every permission request be declined. */
  __autoGrant: boolean;
  __requests: string[][];
  __tabs: TabRecord[];
  __windows: { id: number; url?: string; focused?: boolean }[];
  __data: Map<string, unknown>;
  __listenerCount: () => number;
  __setQuotaBytesPerItem: (bytes: number) => void;
  /** How many sync set/remove calls have been made. One call is one write operation. */
  __writeOps: () => number;
  /**
   * Refuses sync writes past `limit`, the way Chrome does when the per-minute quota is
   * spent, with Chrome's own wording.
   */
  __setWriteLimit: (limit: number) => void;
}

export const QUOTA_BYTES_PER_ITEM = 8192;

export function createFakeChrome(): FakeChrome {
  const data = new Map<string, unknown>();
  const listeners = new Set<Listener>();
  let quota = QUOTA_BYTES_PER_ITEM;

  const tabs: TabRecord[] = [
    { id: 1, url: 'about:blank', windowId: 10, active: true, groupId: -1 },
  ];
  const windows: { id: number; url?: string; focused?: boolean }[] = [];
  let nextTabId = 2;
  let nextWindowId = 11;

  const badges = new Map<number, BadgeState>();
  const tabGroups: TabGroupRecord[] = [];
  const menus: MenuRecord[] = [];
  const injections: { tabId: number; args: unknown[]; result: unknown }[] = [];
  const menuListeners: ((info: MenuClick, tab?: TabRecord) => void)[] = [];
  const session = new Map<string, unknown>();
  let nextTabGroupId = 100;

  const granted = new Set<string>();
  const scripts: { id: string; matches?: string[]; js?: string[] }[] = [];
  const requests: string[][] = [];

  const clone = <T>(value: T): T => structuredClone(value);

  let writeOps = 0;
  let writeLimit = Number.POSITIVE_INFINITY;

  /**
   * Counts a write and refuses it past the limit.
   *
   * Called BEFORE anything is stored, because that is the order that matters: Chrome
   * rejects the whole request, so a caller that loops leaves the earlier writes committed
   * and the later ones not. That half-applied state is the thing worth testing against.
   */
  const countWrite = (): void => {
    writeOps += 1;
    if (writeOps > writeLimit) {
      throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
    }
  };

  const emit = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): void => {
    for (const listener of [...listeners]) listener(changes, 'sync');
  };

  const badgeFor = (tabId: number | undefined): BadgeState => {
    const key = tabId ?? -1;
    const existing = badges.get(key);
    if (existing) return existing;
    const created: BadgeState = {};
    badges.set(key, created);
    return created;
  };

  const self = {
    action: {
      async setBadgeText({ tabId, text }: { tabId?: number; text?: string }) {
        // Real Chrome rejects for a tab that has gone; the badge code relies on that
        // being survivable.
        if (tabId !== undefined && !tabs.some((tab) => tab.id === tabId)) {
          throw new Error(`No tab with id ${tabId}`);
        }
        badgeFor(tabId).text = text;
      },
      async setBadgeBackgroundColor({ tabId, color }: { tabId?: number; color?: string }) {
        badgeFor(tabId).background = color;
      },
      async setBadgeTextColor({ tabId, color }: { tabId?: number; color?: string }) {
        badgeFor(tabId).textColor = color;
      },
      async setTitle({ tabId, title }: { tabId?: number; title?: string }) {
        if (tabId !== undefined && !tabs.some((tab) => tab.id === tabId)) {
          throw new Error(`No tab with id ${tabId}`);
        }
        badgeFor(tabId).title = title;
      },
    },

    runtime: {
      getManifest: () => ({
        name: 'WhichEnv: Environment Indicator and Switcher',
        short_name: 'WhichEnv',
        version: '0.0.0-test',
      }),
    },

    contextMenus: {
      // Chrome rejects a duplicate id rather than replacing, which is why the real code
      // removes everything before rebuilding. Mirrored so that bug would show up here.
      create: (props: MenuRecord) => {
        if (menus.some((menu) => menu.id === props.id)) {
          throw new Error(`Cannot create item with duplicate id ${props.id}`);
        }
        menus.push(props);
        return props.id;
      },
      removeAll: (done?: () => void) => {
        menus.length = 0;
        done?.();
      },
      onClicked: {
        addListener: (listener: (info: MenuClick, tab?: TabRecord) => void) => {
          menuListeners.push(listener);
        },
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async get(groupId: number) {
        const found = tabGroups.find((group) => group.id === groupId);
        if (!found) throw new Error(`No group with id ${groupId}`);
        return { ...found };
      },
      async query(filter: { windowId?: number; title?: string }) {
        return tabGroups
          .filter(
            (group) =>
              (filter.windowId === undefined || group.windowId === filter.windowId) &&
              (filter.title === undefined || group.title === filter.title),
          )
          .map((group) => ({ ...group }));
      },
      async update(groupId: number, props: { title?: string; color?: string }) {
        const found = tabGroups.find((group) => group.id === groupId);
        if (!found) throw new Error(`No group with id ${groupId}`);
        Object.assign(found, props);
        return { ...found };
      },
    },

    permissions: {
      async getAll() {
        return { permissions: [], origins: [...granted].sort() };
      },
      async contains(query: { origins?: string[] }) {
        const wanted = query.origins ?? [];
        return wanted.every((origin) => granted.has(origin));
      },
      async request(query: { origins?: string[] }) {
        const wanted = query.origins ?? [];
        requests.push([...wanted]);
        if (!self.__autoGrant) return false;
        for (const origin of wanted) granted.add(origin);
        return true;
      },
      async remove(query: { origins?: string[] }) {
        for (const origin of query.origins ?? []) granted.delete(origin);
        return true;
      },
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },

    scripting: {
      async getRegisteredContentScripts(filter?: { ids?: string[] }) {
        if (!filter?.ids) return scripts.map((script) => ({ ...script }));
        return scripts.filter((script) => filter.ids?.includes(script.id)).map((s2) => ({ ...s2 }));
      },
      async registerContentScripts(next: { id: string; matches?: string[]; js?: string[] }[]) {
        for (const script of next) {
          if (scripts.some((existing) => existing.id === script.id)) {
            throw new Error(`Duplicate script ID '${script.id}'`);
          }
          scripts.push({ ...script });
        }
      },
      async updateContentScripts(next: { id: string; matches?: string[]; js?: string[] }[]) {
        for (const script of next) {
          const index = scripts.findIndex((existing) => existing.id === script.id);
          if (index === -1) throw new Error(`No script with ID '${script.id}'`);
          scripts[index] = { ...scripts[index], ...script };
        }
      },
      async unregisterContentScripts(filter?: { ids?: string[] }) {
        const ids = filter?.ids;
        for (let i = scripts.length - 1; i >= 0; i -= 1) {
          if (!ids || ids.includes(scripts[i]!.id)) scripts.splice(i, 1);
        }
      },
      /**
       * Records the injection instead of running the function.
       *
       * Deliberately does NOT execute it. The functions injected by this extension exist to
       * touch `navigator.clipboard` and the DOM, neither of which is present here, so running
       * them would fail for reasons that say nothing about the code under test. What matters
       * at this boundary is WHICH tab was targeted and WHAT was handed to it; whether the
       * write itself lands is covered end to end in a real browser.
       */
      async executeScript(injection: {
        target: { tabId: number };
        args?: unknown[];
        func: (...args: never[]) => unknown;
      }) {
        if (!self.__allowInjection) {
          throw new Error('Cannot access contents of the page');
        }
        if (!tabs.some((tab) => tab.id === injection.target.tabId)) {
          throw new Error(`No tab with id ${injection.target.tabId}`);
        }
        const args = injection.args ?? [];
        const result = self.__injectionResult;
        injections.push({ tabId: injection.target.tabId, args, result });
        return [{ result }];
      },
    },

    tabs: {
      async update(tabId, props) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        if (props.url !== undefined) tab.url = props.url;
        return tab;
      },

      async create(props) {
        const tab: TabRecord = {
          id: nextTabId++,
          url: props.url ?? 'about:blank',
          windowId: props.windowId ?? 10,
          active: props.active ?? true,
          groupId: -1,
          ...(props.openerTabId === undefined ? {} : { openerTabId: props.openerTabId }),
        };
        tabs.push(tab);
        return tab;
      },

      async query(info: Record<string, unknown> = {}) {
        return tabs
          .filter((tab) => info.groupId === undefined || tab.groupId === info.groupId)
          .map((tab) => ({ ...tab }));
      },

      async get(tabId: number) {
        const found = tabs.find((tab) => tab.id === tabId);
        if (!found) throw new Error(`No tab with id ${tabId}`);
        return { ...found };
      },

      async group(options: {
        tabIds: number[];
        groupId?: number;
        createProperties?: { windowId?: number };
      }) {
        const first = tabs.find((tab) => tab.id === options.tabIds[0]);
        const windowId = options.createProperties?.windowId ?? first?.windowId ?? 10;

        let groupId = options.groupId;
        if (groupId === undefined) {
          groupId = nextTabGroupId++;
          tabGroups.push({ id: groupId, windowId });
        } else if (!tabGroups.some((group) => group.id === groupId)) {
          throw new Error(`No group with id ${groupId}`);
        }

        for (const tabId of options.tabIds) {
          const tab = tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.groupId = groupId;
        }
        return groupId;
      },
    },

    windows: {
      async create(props) {
        const created = { id: nextWindowId++, ...props };
        windows.push(created);
        return created;
      },
    },

    storage: {
      sync: {
        async get(keys) {
          if (keys === null || keys === undefined) {
            return Object.fromEntries([...data.entries()].map(([k, v]) => [k, clone(v)]));
          }
          const list = typeof keys === 'string' ? [keys] : keys;
          const result: Record<string, unknown> = {};
          for (const key of list) {
            if (data.has(key)) result[key] = clone(data.get(key));
          }
          return result;
        },

        async set(items) {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};

          countWrite();

          for (const [key, value] of Object.entries(items)) {
            const bytes = new TextEncoder().encode(key + JSON.stringify(value)).length;
            if (bytes > quota) {
              throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded for "${key}"`);
            }
          }

          for (const [key, value] of Object.entries(items)) {
            const oldValue = data.has(key) ? clone(data.get(key)) : undefined;
            data.set(key, clone(value));
            changes[key] = { oldValue, newValue: clone(value) };
          }

          if (Object.keys(changes).length) emit(changes);
        },

        async remove(keys) {
          const list = typeof keys === 'string' ? [keys] : keys;
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          countWrite();
          for (const key of list) {
            if (!data.has(key)) continue;
            changes[key] = { oldValue: clone(data.get(key)) };
            data.delete(key);
          }
          if (Object.keys(changes).length) emit(changes);
        },

        async clear() {
          data.clear();
        },
      },

      session: {
        async get(keys?: string | string[] | null) {
          if (keys === null || keys === undefined) {
            return Object.fromEntries([...session.entries()].map(([k, v]) => [k, clone(v)]));
          }
          const list = typeof keys === 'string' ? [keys] : keys;
          const result: Record<string, unknown> = {};
          for (const key of list) {
            if (session.has(key)) result[key] = clone(session.get(key));
          }
          return result;
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) session.set(key, clone(value));
        },
        async remove(keys: string | string[]) {
          for (const key of typeof keys === 'string' ? [keys] : keys) session.delete(key);
        },
      },

      onChanged: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },

    __tabGroups: tabGroups,
    __session: session,
    __menus: menus,
    __injections: injections,
    __allowInjection: true,
    __injectionResult: true,
    __clickMenu: (info: MenuClick, tab?: TabRecord) => {
      for (const listener of menuListeners) listener(info, tab);
    },
    __badges: badges,
    __granted: granted,
    __scripts: scripts,
    __autoGrant: true,
    __requests: requests,
    __tabs: tabs,
    __windows: windows,
    __data: data,
    __listenerCount: () => listeners.size,
    __setQuotaBytesPerItem(bytes: number) {
      quota = bytes;
    },
    __writeOps: () => writeOps,
    __setWriteLimit(limit: number) {
      writeLimit = limit;
    },
  } as FakeChrome;

  return self;
}

/**
 * Installs a fresh fake onto globalThis and returns it.
 *
 * Call from beforeEach so no state leaks between tests.
 */
export function installFakeChrome(): FakeChrome {
  const fake = createFakeChrome();
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('crypto.randomUUID is required; run tests on Node 20 or newer.');
  }
  return fake;
}
