/**
 * @vitest-environment jsdom
 *
 * The DOM helpers are used by every piece of UI, so a mistake in them shows up as a
 * subtly wrong form rather than an obvious crash. They are small enough to pin down
 * exactly.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { append, clear, el, field, setFieldIssues } from '../../src/ui/dom';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('el', () => {
  it('creates an element with properties assigned', () => {
    const node = el('input', { type: 'text', value: 'hello', disabled: true });
    expect(node.tagName).toBe('INPUT');
    expect(node.value).toBe('hello');
    expect(node.disabled).toBe(true);
  });

  it('maps class, style, dataset and attrs to the right places', () => {
    const node = el('div', {
      class: 'a b',
      style: { color: 'rgb(1, 2, 3)' },
      dataset: { envKey: 'prod' },
      attrs: { 'aria-hidden': 'true' },
    });
    expect(node.className).toBe('a b');
    expect(node.style.color).toBe('rgb(1, 2, 3)');
    expect(node.dataset.envKey).toBe('prod');
    expect(node.getAttribute('aria-hidden')).toBe('true');
  });

  it('appends children, including plain strings', () => {
    const node = el('p', {}, ['hello ', el('strong', { textContent: 'world' })]);
    expect(node.textContent).toBe('hello world');
  });

  // Conditional children are written as `cond ? node : null` all over the UI, so these
  // have to be skipped rather than becoming "null" text.
  it('skips null, undefined and false children', () => {
    const node = el('p', {}, ['a', null, undefined, false, 'b']);
    expect(node.textContent).toBe('ab');
    expect(node.childNodes).toHaveLength(2);
  });
});

describe('append and clear', () => {
  it('appends onto an existing node', () => {
    const node = el('div');
    append(node, ['x', null, el('span')]);
    expect(node.childNodes).toHaveLength(2);
  });

  it('empties a node', () => {
    const node = el('div', {}, ['a', el('span')]);
    clear(node);
    expect(node.childNodes).toHaveLength(0);
  });
});

describe('field', () => {
  it('links the label to the control', () => {
    const input = el('input', { type: 'text' });
    const wrapper = field('Title', input, { id: 'group-title' });
    expect(input.id).toBe('group-title');
    expect(wrapper.querySelector('label')?.getAttribute('for')).toBe('group-title');
  });

  it('marks a required field', () => {
    const wrapper = field('Title', el('input'), { required: true });
    expect(wrapper.querySelector('.req')).not.toBeNull();
  });

  it('omits the hint when there is none', () => {
    expect(field('Title', el('input')).querySelector('.field-hint')).toBeNull();
    expect(
      field('Title', el('input'), { hint: 'Some hint' }).querySelector('.field-hint')?.textContent,
    ).toBe('Some hint');
  });

  it('always leaves a container for validation messages', () => {
    expect(field('Title', el('input')).querySelector('.field-issues')).not.toBeNull();
  });
});

describe('setFieldIssues', () => {
  it('renders messages with a class per severity', () => {
    const wrapper = field('Title', el('input'));
    setFieldIssues(wrapper, [
      { message: 'Bad', severity: 'error' },
      { message: 'Odd', severity: 'warning' },
    ]);
    expect(wrapper.querySelectorAll('.issue-error')).toHaveLength(1);
    expect(wrapper.querySelectorAll('.issue-warning')).toHaveLength(1);
  });

  // The class drives the red border, so it must track errors only, not warnings.
  it('flags the field only for errors', () => {
    const wrapper = field('Title', el('input'));
    setFieldIssues(wrapper, [{ message: 'Odd', severity: 'warning' }]);
    expect(wrapper.classList.contains('has-error')).toBe(false);

    setFieldIssues(wrapper, [{ message: 'Bad', severity: 'error' }]);
    expect(wrapper.classList.contains('has-error')).toBe(true);
  });

  it('replaces previous messages rather than appending', () => {
    const wrapper = field('Title', el('input'));
    setFieldIssues(wrapper, [{ message: 'One', severity: 'error' }]);
    setFieldIssues(wrapper, [{ message: 'Two', severity: 'error' }]);
    expect(wrapper.querySelectorAll('.issue')).toHaveLength(1);
    expect(wrapper.textContent).toContain('Two');
  });

  it('clears the flag when the issues go away', () => {
    const wrapper = field('Title', el('input'));
    setFieldIssues(wrapper, [{ message: 'Bad', severity: 'error' }]);
    setFieldIssues(wrapper, []);
    expect(wrapper.classList.contains('has-error')).toBe(false);
    expect(wrapper.querySelectorAll('.issue')).toHaveLength(0);
  });

  it('does nothing for a missing field, rather than throwing', () => {
    expect(() => setFieldIssues(null, [{ message: 'x', severity: 'error' }])).not.toThrow();
  });
});
