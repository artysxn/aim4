// ---------------------------------------------------------------------------
// src/site/admin/dom.js
// Tiny DOM helpers shared by the admin panels.
//
// Everything here builds nodes and sets textContent. Nothing takes an HTML
// string, deliberately: the admin panel renders usernames, team names, grant
// reasons and audit payloads, all of which are attacker-controlled text from
// the panel's point of view, and innerHTML on any of them would make the panel
// the easiest XSS target in the app.
// ---------------------------------------------------------------------------

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

export function row(...children) {
  const node = el('div', 'admin-row');
  node.append(...children.filter(Boolean));
  return node;
}

export function button(text, onClick, className = 'btn') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function field(labelText, input) {
  const wrap = el('label', 'admin-field');
  wrap.appendChild(el('span', 'admin-field-label', labelText));
  wrap.appendChild(input);
  return wrap;
}

export function input(type = 'text', value = '', placeholder = '') {
  const node = document.createElement('input');
  node.type = type;
  node.value = value;
  if (placeholder) node.placeholder = placeholder;
  return node;
}

export function select(options, value = '') {
  const node = document.createElement('select');
  for (const opt of options) {
    const option = document.createElement('option');
    const isPair = typeof opt === 'object' && opt !== null;
    option.value = isPair ? opt.value : opt;
    option.textContent = isPair ? opt.label : opt;
    node.appendChild(option);
  }
  node.value = value;
  return node;
}

export function table(headers, rows) {
  const node = el('table', 'admin-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const h of headers) headRow.appendChild(el('th', null, h));
  thead.appendChild(headRow);
  node.appendChild(thead);

  const tbody = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    for (const cell of cells) {
      const td = el('td');
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell == null ? '' : String(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  node.appendChild(tbody);
  return node;
}

export function date(value) {
  if (!value) return '';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? String(value) : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function bytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

/** Replace a container's contents with one node. */
export function render(container, node) {
  container.replaceChildren(node);
}

export function notice(container, message, kind = 'info') {
  const node = el('div', `admin-notice admin-notice-${kind}`, message);
  container.prepend(node);
  setTimeout(() => node.remove(), 6000);
}
