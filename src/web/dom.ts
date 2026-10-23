type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** A labelled group of radio buttons styled as a segmented control. */
export function segmented<T extends string>(
  label: string,
  options: { value: T; label: string; title?: string }[],
  value: T,
  onChange: (v: T) => void,
  extraClass = '',
): HTMLElement {
  const name = `seg-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return h(
    'fieldset',
    { class: `segmented ${extraClass}` },
    h('legend', {}, label),
    h(
      'div',
      { class: 'segmented-options' },
      options.map((o) =>
        h(
          'label',
          { title: o.title },
          h('input', {
            type: 'radio',
            name,
            value: o.value,
            checked: o.value === value,
            onchange: () => onChange(o.value),
          }),
          h('span', {}, o.label),
        ),
      ),
    ),
  );
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  return h(
    'label',
    { class: 'toggle', title },
    h('input', { type: 'checkbox', role: 'switch', name: label, checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    h('span', { class: 'toggle-track', 'aria-hidden': 'true' }),
    h('span', {}, label),
  );
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}
