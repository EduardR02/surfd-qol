import { ADAPTER_MARKER } from './instrument.js';

export async function loadGameSource(url, text, fetcher = fetch) {
  const marker = text?.indexOf('\n/* surfd-qol-adapter-v') ?? -1;
  if (text != null && (marker < 0 || text.startsWith(ADAPTER_MARKER, marker))) return text;
  // Room hooks rewrite the module in place, so an older patch cannot be stripped off.
  const response = await fetcher(url, {cache: 'no-store', credentials: 'omit'});
  if (!response.ok) throw new Error(`Could not read game module: HTTP ${response.status}`);
  const source = await response.text();
  if (source.includes('\n/* surfd-qol-adapter-v')) throw new Error('Could not read an unmodified game module.');
  return source;
}
