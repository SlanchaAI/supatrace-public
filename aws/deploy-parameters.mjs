import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

function parameterSection(template) {
  const start = template.indexOf('\nParameters:\n');
  const end = template.search(/\n(?:Conditions|Resources):\n/);
  if (start < 0 || end < start) throw new Error('template parameters not found');
  return template.slice(start, end);
}

export function templateParameterNames(template) {
  return [...parameterSection(template).matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]);
}

export function templateParameterDefaults(template) {
  const defaults = {};
  for (const block of parameterSection(template).split(/\n(?=  [A-Za-z])/)) {
    const name = block.match(/^  ([A-Za-z][A-Za-z0-9]*):/);
    const value = block.match(/\n    Default: (?:'([^']*)'|"([^"]*)"|([^\n#]+))/);
    if (name && value) defaults[name[1]] = (value[1] ?? value[2] ?? value[3]).trim();
  }
  return defaults;
}

export function deployParameters(names, currentParameters, artifactKey, defaults = {}, mcpBridgeMode = 'preserve') {
  if (!artifactKey || artifactKey.includes('..') || !artifactKey.startsWith('releases/')) throw new Error('artifact key must be a releases/ object');
  if (!['preserve', 'true', 'false', 'restore'].includes(mcpBridgeMode)) throw new Error('invalid MCP bridge release choice');
  if (mcpBridgeMode !== 'preserve' && !names.includes('McpBridgeEnabled')) throw new Error('MCP bridge parameter is missing');
  let bridgeValue = mcpBridgeMode;
  if (mcpBridgeMode === 'restore') {
    // currentParameters is the snapshot captured BEFORE this release. CloudFormation
    // UsePreviousValue would preserve the newly changed live flag during rollback.
    const saved = (currentParameters || []).filter(p => p.ParameterKey === 'McpBridgeEnabled');
    if (saved.length > 1) throw new Error('ambiguous MCP bridge parameter snapshot');
    bridgeValue = saved.length ? saved[0].ParameterValue : defaults.McpBridgeEnabled;
    if (!['true', 'false'].includes(bridgeValue)) throw new Error('invalid MCP bridge parameter snapshot');
  }
  const current = new Set((currentParameters || []).map(parameter => parameter.ParameterKey));
  const parameters = [];
  for (const name of names) {
    if (name === 'ArtifactKey') parameters.push({ParameterKey: name, ParameterValue: artifactKey});
    else if (name === 'McpBridgeEnabled' && mcpBridgeMode !== 'preserve') parameters.push({ParameterKey: name, ParameterValue: bridgeValue});
    else if (current.has(name)) parameters.push({ParameterKey: name, UsePreviousValue: true});
    else if (Object.hasOwn(defaults, name)) parameters.push({ParameterKey: name, ParameterValue: defaults[name]});
    else throw new Error(`parameter ${name} has no previous value or default`);
  }
  const kept = new Set(parameters.map(parameter => parameter.ParameterKey));
  for (const parameter of currentParameters || []) {
    if (parameter.ParameterKey !== 'ArtifactKey' && !kept.has(parameter.ParameterKey)) {
      throw new Error(`live parameter ${parameter.ParameterKey} is not in the template`);
    }
  }
  return parameters;
}

export function expectedMcpBridgeValue(parameters, prior) {
  const selected = parameters.filter(p => p.ParameterKey === 'McpBridgeEnabled');
  if (selected.length !== 1) throw new Error('ambiguous MCP bridge release parameter');
  const old = prior.filter(p => p.ParameterKey === 'McpBridgeEnabled');
  if (selected[0].UsePreviousValue && old.length !== 1) throw new Error('missing MCP bridge prior value');
  const value = selected[0].UsePreviousValue ? old[0].ParameterValue : selected[0].ParameterValue;
  if (!['true', 'false'].includes(value)) throw new Error('invalid effective MCP bridge value');
  return value;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [templatePath, currentPath, artifactKey, mcpBridgeMode = 'preserve', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('unexpected deploy parameter arguments');
  const template = readFileSync(templatePath, 'utf8');
  const names = templateParameterNames(template);
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  process.stdout.write(JSON.stringify(deployParameters(names, current, artifactKey, templateParameterDefaults(template), mcpBridgeMode)));
}
