/** In-memory stand-in for the DynamoDB calls the metadata store actually makes. Not used in production. */
import {isDeepStrictEqual} from 'node:util';

const mapKey = key => `${key.pk}\0${key.sk}`;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function conditionFailed() {
  const error = new Error('condition');
  error.name = 'ConditionalCheckFailedException';
  return error;
}
function cancelled(reasons) {
  const error = new Error('transaction condition');
  error.name = 'TransactionCanceledException';
  error.CancellationReasons = reasons;
  return error;
}

function tokenize(expr) {
  const tokens = [];
  const re = /\s*(<=|>=|<>|=|<|>|\(|\)|,|:[A-Za-z0-9_]+|#[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/y;
  let match, cursor = 0;
  while ((match = re.exec(expr))) { tokens.push(match[1]); cursor = re.lastIndex; }
  if (cursor !== expr.length) throw new Error(`Cannot parse "${expr}" at ${cursor}`);
  return tokens;
}
function pathOf(token, names = {}) { return token.startsWith('#') ? names[token] : token; }
function has(item, path) { return !!item && Object.prototype.hasOwnProperty.call(item, path); }
function parseOr(tokens) {
  let left = parseAnd(tokens);
  while (tokens[0] === 'OR') { tokens.shift(); left = { op: 'OR', left, right: parseAnd(tokens) }; }
  return left;
}
function parseAnd(tokens) {
  let left = parsePrimary(tokens);
  while (tokens[0] === 'AND') { tokens.shift(); left = { op: 'AND', left, right: parsePrimary(tokens) }; }
  return left;
}
function parsePrimary(tokens) {
  if (tokens[0] === '(') { tokens.shift(); const inner = parseOr(tokens); if (tokens.shift() !== ')') throw new Error('unclosed condition'); return inner; }
  if (tokens[0] === 'attribute_exists' || tokens[0] === 'attribute_not_exists') {
    const op = tokens.shift();
    if (tokens.shift() !== '(') throw new Error(op);
    const path = tokens.shift();
    if (tokens.shift() !== ')') throw new Error(op);
    return { op, path };
  }
  const path = tokens.shift();
  const op = tokens.shift();
  const value = tokens.shift();
  return { op, path, value };
}
function evaluate(node, item, values, names) {
  if (node.op === 'OR') return evaluate(node.left, item, values, names) || evaluate(node.right, item, values, names);
  if (node.op === 'AND') return evaluate(node.left, item, values, names) && evaluate(node.right, item, values, names);
  const path = pathOf(node.path, names);
  if (node.op === 'attribute_exists') return has(item, path);
  if (node.op === 'attribute_not_exists') return !has(item, path);
  if (!has(item, path)) return false;
  const actual = item[path];
  const expected = values[node.value];
  if (node.op === '=') return isDeepStrictEqual(actual, expected);
  if (node.op === '<>') return !isDeepStrictEqual(actual, expected);
  if (node.op === '<') return actual < expected;
  if (node.op === '<=') return actual <= expected;
  if (node.op === '>') return actual > expected;
  if (node.op === '>=') return actual >= expected;
  throw new Error(`Unknown operator ${node.op}`);
}
function passes(expr, item, values = {}, names = {}) {
  if (!expr) return true;
  const tokens = tokenize(expr);
  const tree = parseOr(tokens);
  if (tokens.length) throw new Error(`Leftover condition tokens ${tokens.join(' ')}`);
  return evaluate(tree, item, values, names);
}
function splitCommas(text) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}
function clauses(expr) {
  const found = [];
  const re = /\b(SET|ADD|DELETE|REMOVE)\b/g;
  let match;
  while ((match = re.exec(expr))) found.push({ name: match[1], index: match.index, length: match[0].length });
  return found.map((part, index) => ({ name: part.name, body: expr.slice(part.index + part.length, found[index + 1]?.index ?? expr.length).trim() }));
}
function applyUpdate(item, expr, values = {}, names = {}) {
  for (const clause of clauses(expr)) {
    if (clause.name === 'SET') {
      for (const assignment of splitCommas(clause.body)) {
        const eq = assignment.indexOf('=');
        const path = pathOf(assignment.slice(0, eq).trim(), names);
        const rhs = assignment.slice(eq + 1).trim();
        if (rhs.startsWith('if_not_exists(') && rhs.endsWith(')')) {
          const [rawPath, rawValue] = splitCommas(rhs.slice('if_not_exists('.length, -1));
          const current = pathOf(rawPath.trim(), names);
          item[path] = has(item, current) ? item[current] : values[rawValue.trim()];
        } else item[path] = values[rhs];
      }
    } else if (clause.name === 'ADD') {
      for (const part of splitCommas(clause.body)) {
        const [rawPath, rawValue] = part.split(/\s+/);
        const path = pathOf(rawPath, names);
        item[path] = (has(item, path) ? item[path] : 0) + values[rawValue];
      }
    } else if (clause.name === 'REMOVE') {
      for (const part of splitCommas(clause.body)) delete item[pathOf(part, names)];
    } else throw new Error(`Unsupported update ${clause.name}`);
  }
}

export function commandClasses() {
  const names = ['GetCommand', 'PutCommand', 'DeleteCommand', 'UpdateCommand', 'QueryCommand', 'ScanCommand', 'TransactWriteCommand'];
  return Object.fromEntries(names.map(name => [name, class { constructor(input) { this.name = name; this.input = input; } }]));
}

export class MemoryDynamo {
  constructor() { this.items = new Map(); }
  _get(key) { return this.items.get(mapKey(key)) ?? null; }
  async send(command) {
    const input = command.input;
    if (command.name === 'GetCommand') { const item = this._get(input.Key); return item ? { Item: clone(item) } : {}; }
    if (command.name === 'PutCommand') return this._put(input, true);
    if (command.name === 'DeleteCommand') return this._delete(input, true);
    if (command.name === 'UpdateCommand') return this._update(input, true);
    if (command.name === 'ScanCommand') {
      const rows=[...this.items.values()].sort((a,b)=>mapKey(a).localeCompare(mapKey(b))), after=input.ExclusiveStartKey?rows.filter(r=>mapKey(r).localeCompare(mapKey(input.ExclusiveStartKey))>0):rows, items=after.slice(0,input.Limit??100);
      return {Items:clone(items),...(after.length>items.length?{LastEvaluatedKey:{pk:items.at(-1).pk,sk:items.at(-1).sk}}:{})};
    }
    if (command.name === 'QueryCommand') return this._query(input);
    if (command.name === 'TransactWriteCommand') return this._transact(input);
    throw new Error(`Unsupported ${command.name}`);
  }
  _put(input, single) {
    const existing = this._get(input.Item);
    if (!passes(input.ConditionExpression, existing, input.ExpressionAttributeValues, input.ExpressionAttributeNames)) {
      if (single) throw conditionFailed();
      return false;
    }
    this.items.set(mapKey(input.Item), clone(input.Item));
    return {};
  }
  _delete(input, single) {
    const existing = this._get(input.Key);
    if (!passes(input.ConditionExpression, existing, input.ExpressionAttributeValues, input.ExpressionAttributeNames)) {
      if (single) throw conditionFailed();
      return false;
    }
    const old = clone(existing);
    this.items.delete(mapKey(input.Key));
    return { Attributes: old };
  }
  _update(input, single) {
    const existing = this._get(input.Key);
    if (!passes(input.ConditionExpression, existing, input.ExpressionAttributeValues, input.ExpressionAttributeNames)) {
      if (single) throw conditionFailed();
      return false;
    }
    const item = existing ? clone(existing) : { pk: input.Key.pk, sk: input.Key.sk };
    applyUpdate(item, input.UpdateExpression, input.ExpressionAttributeValues, input.ExpressionAttributeNames);
    this.items.set(mapKey(input.Key), item);
    return { Attributes: clone(item) };
  }
  _query(input) {
    const pk = input.ExpressionAttributeValues[':pk'];
    const prefix = input.ExpressionAttributeValues[':prefix'];
    if (prefix === '') { const error = new Error('empty_sort_key_value'); error.name = 'ValidationException'; throw error; }
    let rows = [...this.items.values()].filter(item => item.pk === pk && (prefix === undefined || item.sk.startsWith(prefix)));
    rows.sort((a, b) => a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0);
    if (input.ScanIndexForward === false) rows.reverse();
    if (input.ExclusiveStartKey) rows = rows.filter(item => item.sk > input.ExclusiveStartKey.sk);
    const page = rows.slice(0, input.Limit ?? rows.length);
    const more = rows.length > page.length;
    return { Items: page.map(clone), ...(more ? { LastEvaluatedKey: { pk: page.at(-1).pk, sk: page.at(-1).sk } } : {}) };
  }
  _transact(input) {
    const before = new Map([...this.items].map(([key, value]) => [key, clone(value)]));
    const saved = this.items;
    this.items = before;
    const reasons = input.TransactItems.map(item => {
      const [kind, op] = Object.entries(item)[0];
      const existing = kind === 'Put' ? this._get(op.Item) : this._get(op.Key);
      const ok = kind === 'ConditionCheck' || kind === 'Put' || kind === 'Update' || kind === 'Delete'
        ? passes(op.ConditionExpression, existing, op.ExpressionAttributeValues, op.ExpressionAttributeNames) : false;
      return { Code: ok ? 'None' : 'ConditionalCheckFailed' };
    });
    if (reasons.some(reason => reason.Code !== 'None')) { this.items = saved; throw cancelled(reasons); }
    input.TransactItems.forEach(item => {
      const [kind, op] = Object.entries(item)[0];
      if (kind === 'Put') this._put(op, false);
      else if (kind === 'Update') this._update(op, false);
      else if (kind === 'Delete') this._delete(op, false);
    });
    return {};
  }
}
