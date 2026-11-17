// Offline regeneration from the explicitly downloaded, pinned Hue source files.
// Requires Node >=22.13 for the build only; generated modules need no dependencies.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root = process.argv[2];
if (!root) throw Error('Pass the explicit upstream source directory');
const pin = '4ac88431eab76b4e12737c1b279dc58dbed87bf8';
const out = new URL('../src/importers/vendor/hue/', import.meta.url);
mkdirSync(out, {recursive: true});
const hash = text => createHash('sha256').update(text).digest('hex');
const pinned = JSON.parse(readFileSync(new URL('source-pins.json', out)));
const inputs = new Map();
function source(name) { const text = readFileSync(join(root, name), 'utf8'); if (hash(text) !== pinned[name]) throw Error('Pinned upstream hash mismatch: ' + name); inputs.set(name, hash(text)); return text; }
function section(text, from, until) {
  const start = text.indexOf(from), end = text.indexOf(until, start);
  if (start < 0 || end <= start) throw Error('Upstream extraction boundary changed');
  return text.slice(start, end);
}
const generated = [];
function emit(name, text) {
  let js = stripTypeScriptTypes(text).replace(/^[ \t]+$/gm, '');
  js = js.replace(/from "\.\.\/traces-import-convert\.js"/g, 'from "./fields.mjs"')
    .replace(/from "\.\/(identity|rows|otel-spans)\.js"/g, 'from "./fields.mjs"')
    .replace(/from "\.\/row-platform-fields\.js"/g, 'from "./row-platform-fields.mjs"');
  js = '// Derived from Hue SDK ' + pin + '. MIT; see LICENSE and provenance.json.\n' + js;
  writeFileSync(new URL(name, out), js);
  generated.push({file: name, sha256: hash(js)});
}
for (const name of ['langsmith', 'braintrust', 'weave', 'opik', 'datadog', 'mlflow', 'row-platform-fields']) emit(name + '.mjs', source(name + '.ts'));
// SupaTrace retains the exact Helicone source record. Hue's separate conversation
// reconstruction fields are not part of our adapter contract, so omit those only.
const helicone = source('helicone.ts')
  .replace('import { requestContent, requestInstructions, responseContent } from "./transcripts.js";\n', '')
  .replace('  const system = embedding ? undefined : requestInstructions(requestBody);\n', '')
  .replace('    ...(requestBody !== undefined\n      ? { input: embedding ? requestBody : requestContent(requestBody)! }\n      : {}),\n', '')
  .replace('    ...(responseBody !== undefined ? { output: responseContent(responseBody)! } : {}),\n', '')
  .replace('    ...(system !== undefined ? { systemInstructions: system } : {}),\n', '');
if (/requestContent|requestInstructions|responseContent|systemInstructions/.test(helicone)) throw Error('Helicone adaptation boundary changed');
emit('helicone.mjs', helicone);
const convert = source('traces-import-convert.ts'), rows = source('rows.ts'), identity = source('identity.ts'), otel = source('otel-spans.ts');
// Only pure parsing helpers are reused. Hue's collector, upload, identity inference,
// source-record offloading and backend dependencies are deliberately not imported.
const fields = [
  section(convert, 'export class ConversionError', 'export const sha256Hex'),
  section(convert, 'export function isObject', '\nfunction object'),
  section(convert, 'const LONG_INTEGER', '/** Langfuse'),
  section(rows, 'const MAX_NANOS', '/** A 32- or 16-hex'),
  section(identity, 'export function identityText', '/** A flattened'),
  otel.slice(otel.indexOf('export function unsigned')),
  // Only Braintrust uses unixNano; identical ISO parsing is shared with row formats.
  'import {isoNanos} from "./row-platform-fields.mjs";\nexport const unixNano = value => isoNanos(value).toString();\n',
].join('\n');
emit('fields.mjs', fields);
const license = source('LICENSE');
writeFileSync(new URL('LICENSE', out), license);
const manifest = {schemaVersion: 1, name: 'hue-sdk-import-parsers', license: 'MIT', repository: 'https://github.com/hue-run/hue-sdk', revision: pin,
  upstreamBase: 'packages/sdk-typescript/src/cli/',
  sources: [...inputs].map(([file, sha256]) => ({file, upstreamPath: file === 'LICENSE' ? file : 'packages/sdk-typescript/src/cli/' + (file === 'traces-import-convert.ts' ? file : 'import-formats/' + file), sha256})), generated,
  adaptations: ['TypeScript annotations removed with Node stripTypeScriptTypes; runtime imports redirected to the retained pure field helpers.', 'Only row parser modules and pure helpers retained; SupaTrace owns validation, privacy projection, grouping, identifiers, storage and export.', 'unixNano delegates to upstream isoNanos (accepts timezone-free UTC timestamps).', 'Helicone omits Hue-derived conversation reconstruction; its exact source record is retained with content opt-in.', 'No Hue network client, uploader, blob offloader, identity inference or extra runtime dependency.']};
writeFileSync(new URL('provenance.json', out), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({revision: pin, modules: generated.length}));
