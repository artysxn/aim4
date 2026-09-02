// ---------------------------------------------------------------------------
// i18n/picker.js
// The one control that changes language, wherever it appears.
//
// It appears twice: in the account card, which is where the setting lives, and
// in the site footer, which is where a signed-out visitor can reach it. Those
// two want the same behaviour and would otherwise be two implementations of it,
// so there is one, and it decides for itself whether there is an account to
// save to.
//
// Writing order matters. The local mirror is set first and the page switches
// immediately, because a language picker that waits on a network round trip
// before doing anything feels broken. The account write follows, and if it
// fails the page is still in the chosen language and the choice still survives
// a reload on this browser; it simply will not follow the account to another
// machine. That is the right way round for this particular failure.
//
// Each option is written in its own language. Somebody looking for Japanese is
// looking for 日本語, not for the word "Japanese" spelled in an alphabet they
// may not be reading the page in.
// ---------------------------------------------------------------------------

import { LANGS } from './langs.js';
import { currentLang, onLangChange, setLang } from './index.js';

/**
 * @param {{ onError?: (err: Error) => void, save?: (id: string) => Promise<unknown>,
 *           className?: string, id?: string }} [opts]
 * @returns {HTMLSelectElement}
 */
export function languageSelect({ onError, save, className = 'site-select', id } = {}) {
  const select = document.createElement('select');
  select.className = className;
  if (id) select.id = id;
  // The control carries no visible label in the footer, so it says what it is
  // to anything that cannot see it sitting under a heading.
  select.setAttribute('aria-label', 'Interface language');

  for (const lang of LANGS) {
    const option = document.createElement('option');
    option.value = lang.id;
    option.textContent = lang.name;
    // The names of the languages are already in their own languages and must
    // stay that way. Marked per option rather than on the select, so the
    // select's own aria-label is still translated.
    option.setAttribute('data-i18n', 'off');
    select.appendChild(option);
  }
  select.value = currentLang();

  // The language can change without anybody touching this control: the footer
  // picker and the one on the account card are two views of one setting, and
  // signing in adopts whatever the account already said. A control that only
  // reads the language once ends up claiming the page is in Chinese while it is
  // in English.
  const stop = onLangChange((id) => {
    if (select.isConnected) select.value = id;
    else stop();
  });

  select.addEventListener('change', async () => {
    const next = select.value;
    const previous = currentLang();
    select.disabled = true;
    try {
      await setLang(next);
      if (save) await save(next);
    } catch (err) {
      // The page is already in the new language and the browser remembers it.
      // Only the account copy failed, so say so rather than reverting what the
      // person just watched happen.
      onError?.(err instanceof Error ? err : new Error(String(err)));
      void previous;
    } finally {
      select.disabled = false;
    }
  });

  return select;
}

/**
 * The footer control, next to the mobile/desktop switch. This is the only way
 * in for a signed-out visitor, since the account page shows them nothing but
 * the plans.
 */
export function addFooterLanguagePicker() {
  const footBottom = document.querySelector('.foot-bottom');
  if (!footBottom || footBottom.querySelector('.foot-lang')) return;
  const sep = document.createElement('span');
  sep.className = 'foot-sep';
  sep.textContent = '·';
  const select = languageSelect({ className: 'site-select foot-lang' });
  footBottom.appendChild(sep);
  footBottom.appendChild(select);
}
