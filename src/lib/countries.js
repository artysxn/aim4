// ---------------------------------------------------------------------------
// countries.js — ISO 3166-1 alpha-2 list for account country flags
// ---------------------------------------------------------------------------

/** Regional indicator flag emoji from a two-letter ISO code (e.g. "US" → 🇺🇸). */
export function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  const u = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(u)) return '';
  return String.fromCodePoint(...[...u].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0)));
}

/** Curated list — enough coverage without a 200-option dropdown. */
export const COUNTRIES = [
  { code: '', name: 'No flag' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'PL', name: 'Poland' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'RU', name: 'Russia' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'AR', name: 'Argentina' },
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colombia' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'CN', name: 'China' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'SG', name: 'Singapore' },
  { code: 'IN', name: 'India' },
  { code: 'PH', name: 'Philippines' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'TH', name: 'Thailand' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'TR', name: 'Turkey' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'IL', name: 'Israel' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'EG', name: 'Egypt' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'KE', name: 'Kenya' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'PT', name: 'Portugal' },
  { code: 'BE', name: 'Belgium' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'AT', name: 'Austria' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'RO', name: 'Romania' },
  { code: 'HU', name: 'Hungary' },
  { code: 'GR', name: 'Greece' },
  { code: 'IE', name: 'Ireland' },
  { code: 'NZ', name: 'New Zealand' }
];

export function countryOptionsHtml(selected = '') {
  const sel = String(selected || '').toUpperCase();
  return COUNTRIES.map(({ code, name }) => {
    const flag = code ? `${flagEmoji(code)} ` : '';
    const label = code ? `${flag}${name}` : name;
    return `<option value="${code}"${code === sel ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

export function normalizeCountryCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  return COUNTRIES.some((x) => x.code === c) ? c : null;
}
