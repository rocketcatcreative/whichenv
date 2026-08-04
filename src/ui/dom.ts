/**
 * Tiny DOM helpers shared by the popup and the options page.
 *
 * Deliberately not a framework. The extension's UI is a handful of forms, and a
 * `createElement` wrapper plus a delegated event helper covers all of it without
 * shipping a runtime or a build-time template compiler.
 */

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], 'style' | 'dataset' | 'children'>
> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
};

export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, style, dataset, attrs, ...rest } = props;

  Object.assign(node, rest);
  if (className) node.className = className;
  if (style) Object.assign(node.style, style);
  if (dataset) for (const [key, value] of Object.entries(dataset)) node.dataset[key] = value;
  if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** A labelled form field wrapper, with room for validation messages below it. */
export function field(
  labelText: string,
  control: HTMLElement,
  options: { hint?: string; required?: boolean; id?: string } = {},
): HTMLElement {
  if (options.id) control.id = options.id;

  const label = el('label', { class: 'field-label', htmlFor: options.id ?? '' }, [
    labelText,
    options.required ? el('span', { class: 'req', textContent: ' *', title: 'Required' }) : null,
  ]);

  return el('div', { class: 'field' }, [
    label,
    control,
    options.hint ? el('p', { class: 'field-hint', textContent: options.hint }) : null,
    el('div', { class: 'field-issues' }),
  ]);
}

/** Renders validation messages into a field created by `field()`. */
export function setFieldIssues(
  fieldEl: Element | null,
  issues: { message: string; severity: 'error' | 'warning' }[],
): void {
  const container = fieldEl?.querySelector('.field-issues');
  if (!container) return;

  container.replaceChildren(
    ...issues.map((issue) =>
      el('p', { class: `issue issue-${issue.severity}`, textContent: issue.message }),
    ),
  );
  fieldEl?.classList.toggle('has-error', issues.some((i) => i.severity === 'error'));
}
