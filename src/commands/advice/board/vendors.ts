// How a vendor shows on the board (#693), and the one key every name maps to (#779).
// An agent files its own name, and an owner writes seats by vendor, so both map here.

/** A vendor's shown name and colour. */
export interface VendorLook {
  name: string;
  color: string;
}

/** Filed names that share one shown name (#693). The hooks file each agent by its --agent name. */
const VENDOR_KEY: Record<string, string> = {
  anthropic: 'claude',
  claude: 'claude',
  'claude-code': 'claude',
  xai: 'grok',
  grok: 'grok',
  muse: 'muse',
  deepseek: 'deepseek',
  'deepseek-harness': 'deepseek',
  'codex-deepseek': 'deepseek',
  'codex on deepseek': 'deepseek',
};

const VENDOR_LOOKS: Record<string, VendorLook> = {
  claude: { name: 'Claude', color: '#d97757' },
  codex: { name: 'Codex', color: '#10a37f' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  antigravity: { name: 'Antigravity', color: '#4285f4' },
  grok: { name: 'Grok', color: '#9ca3af' },
  muse: { name: 'Muse', color: '#0866ff' },
  deepseek: { name: 'DeepSeek', color: '#4d6bfe' },
};
const OTHER_VENDOR_COLOR = '#8b8b8b';

/**
 * The one key a filed vendor name maps to, in lower case. Seats and agents use it, so
 * "deepseek-harness" and "DeepSeek" meet. Codex on a DeepSeek model is DeepSeek.
 */
export function vendorKeyOf(vendor: string, model = ''): string {
  const filed = vendor.trim().toLowerCase();
  let key = Object.hasOwn(VENDOR_KEY, filed) ? VENDOR_KEY[filed] : filed;
  if (key === 'codex' && model.toLowerCase().includes('deepseek')) key = 'deepseek';
  return key;
}

/**
 * How a vendor shows (#693). Claude, Grok, Muse and DeepSeek each have one name.
 * Codex on a DeepSeek model shows as DeepSeek. Claude on that model stays Claude.
 * Any other vendor keeps its filed name, in grey.
 */
export function vendorOf(vendor: string, model = ''): VendorLook {
  const key = vendorKeyOf(vendor, model);
  const known = Object.hasOwn(VENDOR_LOOKS, key) ? VENDOR_LOOKS[key] : null;
  return known ?? { name: vendor.trim() || 'Unknown', color: OTHER_VENDOR_COLOR };
}
