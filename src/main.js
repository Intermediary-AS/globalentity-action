import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const OPERATIONS = ['verify', 'verify-file', 'search', 'resolve'];
const VERIFY_TYPES = ['vat', 'eori', 'lei'];
const USER_AGENT = 'globalentity-action/1 (+https://github.com/Intermediary-AS/globalentity-action)';

export class ActionError extends Error {}

export function getInput(name, env = process.env) {
  const value = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return (value || '').trim();
}

export function getBool(name, env = process.env) {
  const value = getInput(name, env).toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(value)) return true;
  if (['false', 'no', '0', 'off', ''].includes(value)) return false;
  throw new ActionError(`Input "${name}" must be true or false (got "${value}").`);
}

function escapeCommand(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function createLogger(env = process.env, write = (s) => process.stdout.write(s)) {
  const outputs = {};
  const summary = [];
  return {
    outputs,
    summary,
    info: (msg) => write(`${msg}\n`),
    warning: (msg) => write(`::warning::${escapeCommand(msg)}\n`),
    error: (msg) => write(`::error::${escapeCommand(msg)}\n`),
    mask: (value) => { if (value) write(`::add-mask::${escapeCommand(value)}\n`); },
    setOutput(name, value) {
      const text = value === undefined || value === null ? '' : String(value);
      outputs[name] = text;
      if (env.GITHUB_OUTPUT) {
        const delimiter = `ghadelimiter_${randomUUID()}`;
        appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
      }
    },
    addSummary(markdown) {
      summary.push(markdown);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    }
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows
    .map((r) => r.map((v) => v.trim()))
    .filter((r) => r.some((v) => v !== '') && !r[0].startsWith('#'));
}

export function readVerifyFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { throw new ActionError(`Cannot read file "${path}": ${e.message}`); }
  const rows = parseCsv(text);
  if (!rows.length) throw new ActionError(`File "${path}" is empty.`);
  const header = rows[0].map((h) => h.toLowerCase());
  const col = (n) => header.indexOf(n);
  if (col('number') === -1) {
    throw new ActionError(`File "${path}" needs a header row with at least the column "number" (and usually "type" and "country").`);
  }
  return rows.slice(1).map((r, i) => ({
    line: i + 2,
    type: (col('type') === -1 ? 'vat' : r[col('type')] || 'vat').toLowerCase(),
    country: col('country') === -1 ? '' : r[col('country')] || '',
    number: r[col('number')] || '',
    name: col('name') === -1 ? '' : r[col('name')] || ''
  }));
}

export function createClient({ apiKey, apiUrl, timeoutMs, fetchImpl = globalThis.fetch, retries = 2, sleep }) {
  const base = apiUrl.replace(/\/+$/, '');
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  return async function request(method, path, { query, body } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) if (v) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            'x-api-key': apiKey,
            'Accept': 'application/json',
            'User-Agent': USER_AGENT,
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (e) {
        if (attempt < retries) { await wait(1000 * 2 ** attempt); continue; }
        throw new ActionError(`Request to ${url.pathname} failed: ${e.message}`);
      }
      if (res.status >= 500 && attempt < retries) { await wait(1000 * 2 ** attempt); continue; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        throw new ActionError(`GlobalEntity API rejected the API key: ${data.message || 'Missing or invalid API key.'} Get a key at https://www.globalentityapi.com/pricing`);
      }
      if (res.status === 429) throw new ActionError(`Lookup quota exceeded: ${data.message || 'HTTP 429'}`);
      if (!res.ok) throw new ActionError(`GlobalEntity API returned HTTP ${res.status} for ${url.pathname}: ${data.message || res.statusText}`);
      return data;
    }
  };
}

const cell = (v) => String(v === undefined || v === null || v === '' ? '—' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const validText = (v) => (v === true ? 'true' : v === false ? 'false' : 'unknown');
const validIcon = (v) => (v === true ? '✅ valid' : v === false ? '❌ invalid' : '⚠️ unknown');

function verifyQuery({ type, country, number, name }) {
  if (!VERIFY_TYPES.includes(type)) throw new ActionError(`Unknown type "${type}". Use vat, eori or lei.`);
  if (!number) throw new ActionError('Input "number" is required for verify.');
  return { type, country, number, name };
}

async function runVerify(ctx) {
  const q = verifyQuery({ type: ctx.inputs.type.toLowerCase(), country: ctx.inputs.country, number: ctx.inputs.number, name: ctx.inputs.name });
  const data = await ctx.request('GET', '/api/verify', { query: q });
  const name = data.name || data.legalName || '';
  ctx.log.setOutput('valid', validText(data.valid));
  ctx.log.setOutput('name', name);
  ctx.log.setOutput('address', data.address || '');
  ctx.log.setOutput('result', JSON.stringify(data));
  ctx.log.info(`${q.type.toUpperCase()} ${data.input || q.number}: ${validText(data.valid)}${name ? ` — ${name}` : ''}`);
  ctx.log.addSummary([
    '### GlobalEntity verify',
    '',
    '| Type | Number | Result | Name | Address | Source |',
    '|---|---|---|---|---|---|',
    `| ${q.type.toUpperCase()} | ${cell(data.input || q.number)} | ${validIcon(data.valid)} | ${cell(name)} | ${cell(data.address)} | ${cell(data.source)} |`,
    ''
  ].join('\n'));
  return outcome(ctx, data.valid === false ? 1 : 0, data.valid === true || data.valid === false ? 0 : 1, data.message);
}

async function runVerifyFile(ctx) {
  if (!ctx.inputs.file) throw new ActionError('Input "file" is required for verify-file.');
  const rows = readVerifyFile(ctx.inputs.file);
  const results = [];
  for (const row of rows) {
    let data;
    try {
      data = await ctx.request('GET', '/api/verify', { query: verifyQuery(row) });
    } catch (e) {
      if (!(e instanceof ActionError) || /API key|quota/.test(e.message)) throw e;
      data = { valid: null, message: e.message };
    }
    results.push({ line: row.line, type: row.type, country: row.country, number: row.number, valid: data.valid ?? null, name: data.name || '', address: data.address || '', message: data.message || '' });
  }
  const invalid = results.filter((r) => r.valid === false);
  const unknown = results.filter((r) => r.valid !== true && r.valid !== false);
  for (const r of invalid) ctx.log.error(`${ctx.inputs.file} line ${r.line}: ${r.type.toUpperCase()} ${r.number} is invalid`);
  for (const r of unknown) ctx.log.warning(`${ctx.inputs.file} line ${r.line}: ${r.type.toUpperCase()} ${r.number} could not be confirmed${r.message ? ` (${r.message})` : ''}`);
  ctx.log.setOutput('valid', invalid.length ? 'false' : unknown.length ? 'unknown' : 'true');
  ctx.log.setOutput('count', results.length);
  ctx.log.setOutput('invalid-count', invalid.length);
  ctx.log.setOutput('unknown-count', unknown.length);
  ctx.log.setOutput('result', JSON.stringify(results));
  ctx.log.info(`Checked ${results.length} rows: ${results.length - invalid.length - unknown.length} valid, ${invalid.length} invalid, ${unknown.length} unknown.`);
  ctx.log.addSummary([
    `### GlobalEntity verify-file: \`${ctx.inputs.file}\``,
    '',
    `**${results.length}** checked · **${results.length - invalid.length - unknown.length}** valid · **${invalid.length}** invalid · **${unknown.length}** unknown`,
    '',
    '| Line | Type | Country | Number | Result | Name |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.line} | ${r.type.toUpperCase()} | ${cell(r.country)} | ${cell(r.number)} | ${validIcon(r.valid)} | ${cell(r.name || r.message)} |`),
    ''
  ].join('\n'));
  return outcome(ctx, invalid.length, unknown.length);
}

async function runSearch(ctx) {
  const { country, query } = ctx.inputs;
  if (!country || !query) throw new ActionError('Inputs "country" and "query" are required for search.');
  const data = await ctx.request('GET', '/api/registry/search', { query: { country, q: query } });
  if (data.mode === 'error') throw new ActionError(`Search failed: ${data.message || 'unknown error'}`);
  const results = Array.isArray(data.results) ? data.results : [];
  const first = results[0] || {};
  ctx.log.setOutput('count', results.length);
  ctx.log.setOutput('valid', results.length ? 'true' : 'false');
  ctx.log.setOutput('name', first.name || '');
  ctx.log.setOutput('address', first.address || '');
  ctx.log.setOutput('result', JSON.stringify(data));
  ctx.log.info(`Found ${results.length} companies in ${data.country || country}${first.name ? `; first: ${first.name}` : ''}.`);
  ctx.log.addSummary([
    `### GlobalEntity search: "${cell(query)}" in ${cell(data.country || country)}`,
    '',
    '| Name | Reg. no. | Status | Address |',
    '|---|---|---|---|',
    ...results.slice(0, 20).map((r) => `| ${cell(r.name)} | ${cell(r.orgNr)} | ${cell(r.status)} | ${cell(r.address)} |`),
    results.length ? '' : '_No companies found._',
    ''
  ].join('\n'));
  return outcome(ctx, results.length ? 0 : 1, 0, results.length ? '' : 'No companies found.');
}

async function runResolve(ctx) {
  const { country, number, name } = ctx.inputs;
  if (!country) throw new ActionError('Input "country" is required for resolve.');
  if (!number && !name) throw new ActionError('Input "number" or "name" is required for resolve.');
  const body = { country };
  if (number && /^[A-Z0-9]{18}[0-9]{2}$/i.test(number)) body.lei = number.toUpperCase();
  else if (number) body.orgNr = number;
  if (name) body.name = name;
  const data = await ctx.request('POST', '/api/company/resolve', { body });
  const score = data.trust && data.trust.score;
  const legalName = data.name || (Array.isArray(data.names) && data.names[0] && (data.names[0].value || data.names[0].name)) || name || '';
  ctx.log.setOutput('entity-id', data.entityId || '');
  ctx.log.setOutput('trust-score', score ?? '');
  ctx.log.setOutput('name', legalName);
  ctx.log.setOutput('valid', data.entityId ? 'true' : 'unknown');
  ctx.log.setOutput('result', JSON.stringify(data));
  ctx.log.info(`Resolved ${legalName || number} → ${data.entityId || 'no id'} (Trust Score ${score ?? 'n/a'})`);
  ctx.log.addSummary([
    '### GlobalEntity resolve',
    '',
    '| Entity id | Name | Trust Score | Band |',
    '|---|---|---|---|',
    `| ${cell(data.entityId)} | ${cell(legalName)} | ${cell(score)} | ${cell(data.trust && data.trust.band)} |`,
    ''
  ].join('\n'));
  return outcome(ctx, 0, data.entityId ? 0 : 1);
}

function outcome(ctx, invalidCount, unknownCount, message) {
  if (invalidCount && ctx.inputs.failOnInvalid) {
    ctx.log.error(message || `${invalidCount} identifier(s) are invalid.`);
    return 1;
  }
  if (unknownCount) {
    const msg = message || `${unknownCount} identifier(s) could not be confirmed by the official source.`;
    if (ctx.inputs.failOnUnknown) { ctx.log.error(msg); return 1; }
    ctx.log.warning(msg);
  }
  return 0;
}

export async function run({ env = process.env, fetchImpl, log = createLogger(env), sleep } = {}) {
  try {
    const apiKey = getInput('api-key', env);
    if (!apiKey) throw new ActionError('Input "api-key" is required. Add your GlobalEntity API key as a secret and pass it with api-key: ${{ secrets.GLOBALENTITY_API_KEY }}');
    log.mask(apiKey);
    const operation = (getInput('operation', env) || 'verify').toLowerCase();
    if (!OPERATIONS.includes(operation)) throw new ActionError(`Unknown operation "${operation}". Use one of: ${OPERATIONS.join(', ')}.`);
    const timeout = Number(getInput('timeout-seconds', env) || 30);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new ActionError('Input "timeout-seconds" must be a positive number.');
    const inputs = {
      type: getInput('type', env) || 'vat',
      country: getInput('country', env),
      number: getInput('number', env),
      query: getInput('query', env),
      name: getInput('name', env),
      file: getInput('file', env),
      failOnInvalid: getInput('fail-on-invalid', env) === '' ? true : getBool('fail-on-invalid', env),
      failOnUnknown: getBool('fail-on-unknown', env)
    };
    const request = createClient({
      apiKey,
      apiUrl: getInput('api-url', env) || 'https://www.globalentityapi.com',
      timeoutMs: timeout * 1000,
      fetchImpl,
      sleep
    });
    const ctx = { inputs, request, log };
    if (operation === 'verify') return await runVerify(ctx);
    if (operation === 'verify-file') return await runVerifyFile(ctx);
    if (operation === 'search') return await runSearch(ctx);
    return await runResolve(ctx);
  } catch (e) {
    log.error(e instanceof ActionError ? e.message : `Unexpected error: ${e && e.stack ? e.stack : e}`);
    return 1;
  }
}
