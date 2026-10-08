import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruefe, verarbeite, SIMULATIONS_ZIEL } from '../lib/pruefung.js';

const ZIEL = 'https://instanz.example.test/healthz/readiness';
const WEBHOOK = 'https://hooks.slack.example.test/services/T000/B000/geheimerwebhook';
const SECRET = 'a'.repeat(40);
const JETZT = new Date('2026-10-08T12:00:00.000Z');

function antwort(status, text = '') {
  return { status, text: async () => text };
}

function fehler(name, message = 'fehlgeschlagen') {
  const e = new Error(message);
  e.name = name;
  return e;
}

// Fake-fetch: Antworten je Ziel als Warteschlange; protokolliert alle Aufrufe.
function fakeFetch({ gesund = [], slack = [] } = {}) {
  const aufrufe = [];
  const fn = async (url, opts = {}) => {
    aufrufe.push({ url, opts });
    const schlange = url === WEBHOOK ? slack : gesund;
    const naechste = schlange.length > 1 ? schlange.shift() : schlange[0];
    if (naechste instanceof Error) throw naechste;
    if (naechste === undefined) throw new Error(`unerwarteter Aufruf ${url}`);
    return naechste;
  };
  fn.aufrufe = aufrufe;
  return fn;
}

function umgebung(overrides = {}) {
  return {
    CRON_SECRET: SECRET,
    N8N_HEALTH_URL: ZIEL,
    SLACK_WEBHOOK_URL: WEBHOOK,
    ...overrides,
  };
}

function lauf({ auth = `Bearer ${SECRET}`, env = umgebung(), fetchImpl } = {}) {
  const logs = [];
  const pausen = [];
  return verarbeite({
    authHeader: auth,
    env,
    fetchImpl,
    warte: async (ms) => { pausen.push(ms); },
    jetzt: () => JETZT,
    log: (zeile) => logs.push(zeile),
  }).then((r) => ({ ...r, logs, pausen }));
}

// --- pruefe ---------------------------------------------------------------

test('pruefe: 200 beim ersten Versuch ist ok ohne Wiederholung', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  const pausen = [];
  const r = await pruefe({ url: ZIEL, fetchImpl: f, warte: async (ms) => pausen.push(ms) });
  assert.deepEqual(r, { ergebnis: 'ok', versuche: 1 });
  assert.equal(f.aufrufe.length, 1);
  assert.deepEqual(pausen, []);
});

test('pruefe: jeder Abruf hat ein Timeout-Signal', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  await pruefe({ url: ZIEL, fetchImpl: f, warte: async () => {} });
  assert.ok(f.aufrufe[0].opts.signal, 'signal fehlt');
});

test('pruefe: erster Fehlschlag, zweiter Versuch nach 10 s ok', async () => {
  const f = fakeFetch({ gesund: [antwort(503), antwort(200)] });
  const pausen = [];
  const r = await pruefe({ url: ZIEL, fetchImpl: f, warte: async (ms) => pausen.push(ms) });
  assert.deepEqual(r, { ergebnis: 'ok', versuche: 2 });
  assert.deepEqual(pausen, [10000]);
});

test('pruefe: zweimal Timeout ergibt grund timeout', async () => {
  const f = fakeFetch({ gesund: [fehler('TimeoutError')] });
  const r = await pruefe({ url: ZIEL, fetchImpl: f, warte: async () => {} });
  assert.deepEqual(r, { ergebnis: 'fehler', grund: 'timeout', versuche: 2 });
  assert.equal(f.aufrufe.length, 2);
});

test('pruefe: AbortError zaehlt als timeout', async () => {
  const f = fakeFetch({ gesund: [fehler('AbortError')] });
  const r = await pruefe({ url: ZIEL, fetchImpl: f, warte: async () => {} });
  assert.equal(r.grund, 'timeout');
});

test('pruefe: Transportfehler ergibt grund netz ohne Adresse', async () => {
  const f = fakeFetch({ gesund: [new TypeError(`fetch failed ${ZIEL}`)] });
  const r = await pruefe({ url: ZIEL, fetchImpl: f, warte: async () => {} });
  assert.deepEqual(r, { ergebnis: 'fehler', grund: 'netz', versuche: 2 });
  assert.ok(!JSON.stringify(r).includes('instanz.example.test'));
});

test('pruefe: zweimal HTTP-Fehler ergibt grund "http <code>" des letzten Versuchs', async () => {
  const f = fakeFetch({ gesund: [antwort(500), antwort(502)] });
  const r = await pruefe({ url: ZIEL, fetchImpl: f, warte: async () => {} });
  assert.deepEqual(r, { ergebnis: 'fehler', grund: 'http 502', versuche: 2 });
});

// --- verarbeite: Autorisierung -------------------------------------------

for (const [name, auth] of [
  ['fehlender Header', null],
  ['leerer Header', ''],
  ['falsches Secret', `Bearer ${'b'.repeat(40)}`],
  ['Secret ohne Bearer', SECRET],
  ['kuerzeres Secret', `Bearer ${SECRET.slice(1)}`],
]) {
  test(`verarbeite: ${name} -> 401, kein Abruf, kein Alarm`, async () => {
    const f = fakeFetch({ gesund: [antwort(200)], slack: [antwort(200, 'ok')] });
    const r = await lauf({ auth, fetchImpl: f });
    assert.equal(r.status, 401);
    assert.equal(f.aufrufe.length, 0);
  });
}

test('verarbeite: fehlt CRON_SECRET in der Umgebung, ist alles 401', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  const r = await lauf({ auth: 'Bearer ', env: umgebung({ CRON_SECRET: '' }), fetchImpl: f });
  assert.equal(r.status, 401);
  assert.equal(f.aufrufe.length, 0);
  const r2 = await lauf({ auth: 'Bearer undefined', env: umgebung({ CRON_SECRET: undefined }), fetchImpl: f });
  assert.equal(r2.status, 401);
  assert.equal(f.aufrufe.length, 0);
});

// --- verarbeite: ok / fehler ---------------------------------------------

test('verarbeite: gueltig + ok -> 200 {ergebnis: ok}, kein Slack', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  const r = await lauf({ fetchImpl: f });
  assert.equal(r.status, 200);
  assert.equal(r.body.ergebnis, 'ok');
  assert.equal(f.aufrufe.length, 1);
  assert.equal(f.aufrufe[0].url, ZIEL);
});

test('verarbeite: ok braucht keinen Webhook', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  const r = await lauf({ env: umgebung({ SLACK_WEBHOOK_URL: undefined }), fetchImpl: f });
  assert.equal(r.status, 200);
});

test('verarbeite: gueltig + fehler -> Slack-POST mit Text, Antwort ok -> 500 alarm gesendet', async () => {
  const f = fakeFetch({ gesund: [antwort(503)], slack: [antwort(200, 'ok')] });
  const r = await lauf({ fetchImpl: f });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { ergebnis: 'fehler', grund: 'http 503', alarm: 'gesendet' });
  const post = f.aufrufe.find((a) => a.url === WEBHOOK);
  assert.ok(post, 'kein Slack-Aufruf');
  assert.equal(post.opts.method, 'POST');
  assert.ok(post.opts.signal, 'Slack-Aufruf ohne Timeout');
  const text = JSON.parse(post.opts.body).text;
  assert.equal(text, 'Heartbeat: n8n-Instanz nicht erreichbar (http 503, 2026-10-08T12:00:00Z)');
  assert.ok(!text.includes('instanz.example.test'));
});

test('verarbeite: Slack antwortet nicht "ok" -> alarm fehlgeschlagen', async () => {
  const f = fakeFetch({ gesund: [antwort(503)], slack: [antwort(404, 'no_service')] });
  const r = await lauf({ fetchImpl: f });
  assert.equal(r.status, 500);
  assert.equal(r.body.alarm, 'fehlgeschlagen');
});

test('verarbeite: Slack 200 mit anderem Text -> alarm fehlgeschlagen', async () => {
  const f = fakeFetch({ gesund: [antwort(503)], slack: [antwort(200, 'invalid_payload')] });
  const r = await lauf({ fetchImpl: f });
  assert.equal(r.body.alarm, 'fehlgeschlagen');
});

test('verarbeite: Slack wirft -> alarm fehlgeschlagen, keine Ausnahme nach aussen', async () => {
  const f = fakeFetch({ gesund: [antwort(503)], slack: [new TypeError('fetch failed')] });
  const r = await lauf({ fetchImpl: f });
  assert.equal(r.status, 500);
  assert.equal(r.body.alarm, 'fehlgeschlagen');
});

test('verarbeite: fehlt SLACK_WEBHOOK_URL bei Fehler -> 500 alarm nicht-konfiguriert mit Log-Zeile', async () => {
  const f = fakeFetch({ gesund: [antwort(503)] });
  const r = await lauf({ env: umgebung({ SLACK_WEBHOOK_URL: '' }), fetchImpl: f });
  assert.equal(r.status, 500);
  assert.equal(r.body.alarm, 'nicht-konfiguriert');
  assert.ok(r.logs.some((z) => z.includes('alarm=nicht-konfiguriert')));
});

test('verarbeite: fehlt N8N_HEALTH_URL -> fehler konfiguration mit Alarm, kein Abruf der Instanz', async () => {
  const f = fakeFetch({ slack: [antwort(200, 'ok')] });
  const r = await lauf({ env: umgebung({ N8N_HEALTH_URL: '' }), fetchImpl: f });
  assert.equal(r.status, 500);
  assert.equal(r.body.grund, 'konfiguration');
  assert.equal(r.body.alarm, 'gesendet');
  assert.deepEqual(f.aufrufe.map((a) => a.url), [WEBHOOK]);
});

// --- Simulation ----------------------------------------------------------

test('verarbeite: Simulation prueft das .invalid-Ziel und markiert den Slack-Text', async () => {
  const f = fakeFetch({ gesund: [new TypeError('getaddrinfo ENOTFOUND')], slack: [antwort(200, 'ok')] });
  const r = await lauf({ env: umgebung({ HEARTBEAT_SIMULATION: 'instanz-weg' }), fetchImpl: f });
  assert.equal(SIMULATIONS_ZIEL, 'https://heartbeat-simulation.invalid/healthz/readiness');
  const pruefAufrufe = f.aufrufe.filter((a) => a.url !== WEBHOOK).map((a) => a.url);
  assert.deepEqual(pruefAufrufe, [SIMULATIONS_ZIEL, SIMULATIONS_ZIEL]);
  const text = JSON.parse(f.aufrufe.find((a) => a.url === WEBHOOK).opts.body).text;
  assert.ok(text.startsWith('[SIMULATION] Heartbeat: n8n-Instanz nicht erreichbar (netz, '), text);
  assert.equal(r.body.alarm, 'gesendet');
  assert.equal(r.body.simulation, 'instanz-weg');
  assert.ok(r.logs.some((z) => z.includes('simulation=instanz-weg')));
});

test('verarbeite: unbekannter Simulationswert wird ignoriert', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  const r = await lauf({ env: umgebung({ HEARTBEAT_SIMULATION: 'irgendwas' }), fetchImpl: f });
  assert.equal(r.status, 200);
  assert.equal(f.aufrufe[0].url, ZIEL);
});

// --- Log-Zeile -----------------------------------------------------------

test('Log: genau eine Zeile je Lauf im festen Format', async () => {
  const f = fakeFetch({ gesund: [antwort(503)], slack: [antwort(200, 'ok')] });
  const r = await lauf({ fetchImpl: f });
  assert.equal(r.logs.length, 1);
  assert.match(
    r.logs[0],
    /^zeit_utc=2026-10-08T12:00:00Z ergebnis=fehler grund=http_503 simulation=aus alarm=gesendet$/,
  );
});

test('Log: ok-Lauf', async () => {
  const f = fakeFetch({ gesund: [antwort(200)] });
  const r = await lauf({ fetchImpl: f });
  assert.deepEqual(r.logs, ['zeit_utc=2026-10-08T12:00:00Z ergebnis=ok grund=- simulation=aus alarm=-']);
});

test('Log und Antworten enthalten nie Adresse, Webhook oder Secret', async () => {
  const faelle = [
    { auth: null, f: fakeFetch({ gesund: [antwort(200)] }) },
    { f: fakeFetch({ gesund: [antwort(200)] }) },
    { f: fakeFetch({ gesund: [new TypeError(`connect ECONNREFUSED ${ZIEL}`)], slack: [new TypeError(`fail ${WEBHOOK}`)] }) },
    { f: fakeFetch({ gesund: [antwort(503)], slack: [antwort(200, 'ok')] }) },
    { f: fakeFetch({ gesund: [antwort(503)] }), env: umgebung({ SLACK_WEBHOOK_URL: '' }) },
  ];
  for (const fall of faelle) {
    const r = await lauf({ auth: 'auth' in fall ? fall.auth : `Bearer ${SECRET}`, env: fall.env, fetchImpl: fall.f });
    const alles = r.logs.join('\n') + JSON.stringify(r.body);
    for (const verboten of ['instanz.example.test', 'hooks.slack', 'geheimerwebhook', SECRET]) {
      assert.ok(!alles.includes(verboten), `${verboten} in Ausgabe: ${alles}`);
    }
  }
});
