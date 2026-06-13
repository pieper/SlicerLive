// Browser shim for Node's "url" module. vtk.js's XML IO pulls @oozcitak/url (Node-only) via the XML
// builder, but our binary-inline VTP/VTI never resolves external refs, so these are never called.
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export function parse() { return {}; }
export function format() { return ''; }
export function resolve() { return ''; }
export function domainToASCII(s) { return s; }
export function domainToUnicode(s) { return s; }
export default { URL, URLSearchParams, parse, format, resolve, domainToASCII, domainToUnicode };
