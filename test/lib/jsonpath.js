// Minimal evaluator for the expected-value conventions of test/fixtures/official-vectors.json
// (extracted from the Receita Federal repo's own tests; see its meta.expectedConventions).
const ABSENT = Symbol('absent');

function get(node, path) {
  const toks = [...path.replace(/^\$\.?/, '').matchAll(/([^.[\]]+)|\[(\d+|\*)\]/g)].map((m) => m[1] ?? m[2]);
  let cur = [node];
  let multi = false;
  for (const t of toks) {
    if (t === '<keys>') return { value: cur.map((c) => (c && typeof c === 'object' ? Object.keys(c) : ABSENT)), multi, keys: true };
    if (t === 'length()') return { value: cur.map((c) => (Array.isArray(c) ? c.length : ABSENT)), multi };
    if (t === '*') { multi = true; cur = cur.flatMap((c) => (Array.isArray(c) ? c : [])); continue; }
    cur = cur.map((c) => (c != null && typeof c === 'object' && t in c ? c[t] : ABSENT));
  }
  return { value: cur, multi };
}
const asText = (v) => (v === ABSENT ? '<absent>' : v === null ? '<null>' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Returns null when ok, or a string describing the mismatch. */
export function check(status, body, key, expected) {
  if (key === 'httpStatus') return String(status) === expected ? null : `status ${status} != ${expected}`;
  const { value, multi, keys } = get(body, key);
  const actual = multi ? value : value[0];
  const text = keys ? JSON.stringify(actual) : multi ? JSON.stringify(actual.map((v) => (v === ABSENT ? null : v))) : asText(actual);
  const m = /^<([A-Za-z-]+)(?::([\s\S]*))?>$/.exec(expected);
  if (m) {
    const [, op, arg] = m;
    const list = multi ? actual : null;
    switch (op) {
      case 'absent': return actual === ABSENT || (multi && actual.length === 0) ? null : `${key} present: ${text}`;
      case 'null': return actual === null ? null : `${key} = ${text}, expected null`;
      case 'present': return actual !== ABSENT && actual !== null ? null : `${key} absent`;
      case 'nonblank': return typeof actual === 'string' && actual.trim() ? null : `${key} blank`;
      case 'contains': return (list ? list.some((x) => String(x).includes(arg)) : typeof actual === 'string' ? actual.includes(arg) : text.includes(arg)) ? null : `${key} = ${text} lacks '${arg}'`;
      case 'not-contains': return !text.includes(arg) ? null : `${key} contains '${arg}'`;
      case 'endsWith': return String(actual).endsWith(arg) ? null : `${key} = ${text} !endsWith ${arg}`;
      case 'not': return text !== arg ? null : `${key} = ${arg}`;
      case 'not-array': return !Array.isArray(actual) ? null : `${key} is array`;
      case 'gte': return Number(actual) >= Number(arg) ? null : `${key} = ${text} < ${arg}`;
      default: return `unknown matcher ${expected}`;
    }
  }
  if (multi && expected.startsWith('[')) {
    return JSON.stringify(actual) === JSON.stringify(JSON.parse(expected)) ? null : `${key} = ${JSON.stringify(actual)} != ${expected}`;
  }
  if (keys) return JSON.stringify(actual) === JSON.stringify(JSON.parse(expected)) ? null : `${key} keys ${JSON.stringify(actual)} != ${expected}`;
  return text === expected ? null : `${key} = ${text} != ${expected}`;
}
