// ---------------------------------------------------------------------------
// icons/menubuttons.js
// Leading icons for filter controls (map, players, teams, search, winner, rounds).
// ---------------------------------------------------------------------------

import mapIcon from './menubuttons/menubutton_map.svg?url';
import playerIcon from './menubuttons/menubutton_player.svg?url';
import teamIcon from './menubuttons/menubutton_team.svg?url';
import searchIcon from './menubuttons/menubutton_search.svg?url';
import starIcon from './menubuttons/menubutton_star.svg?url';
import menuIcon from './menubuttons/menubutton_menu.svg?url';

export const MENU_BTN = {
  map: mapIcon,
  player: playerIcon,
  team: teamIcon,
  search: searchIcon,
  star: starIcon,
  menu: menuIcon
};

/** Leading `<img>` for buttons, tabs, and summary labels. */
export function mbIcon(kind, size = 14) {
  const src = MENU_BTN[kind];
  if (!src) return '';
  return `<img class="mb-icon" src="${src}" alt="" width="${size}" height="${size}" draggable="false" />`;
}

/** Wrap a select / input / toggle so the icon sits left of the text. */
export function mbWrap(kind, controlHtml) {
  return `<div class="mb-control mb-control--${kind}">${mbIcon(kind)}${controlHtml}</div>`;
}

/** Icon + label for flex summaries that already own a chevron. */
export function mbSummary(kind, labelHtml) {
  return `<span class="mb-summary">${mbIcon(kind)}<span class="mb-label">${labelHtml}</span></span>`;
}
