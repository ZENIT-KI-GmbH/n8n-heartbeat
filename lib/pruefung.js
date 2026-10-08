// Reine Logik des Heartbeats. Alle Abhaengigkeiten (fetch, Warten, Uhr, Log) werden injiziert.
import { timingSafeEqual } from 'node:crypto';

export const SIMULATIONS_ZIEL = 'https://heartbeat-simulation.invalid/healthz/readiness';
export const TIMEOUT_MS = 20000;
export const PAUSE_MS = 10000;
export const SLACK_TIMEOUT_MS = 5000;

function grundAusFehler(err) {
  const name = err && err.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'netz';
}

async function versuch(url, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200 ? null : `http ${res.status}`;
  } catch (err) {
    return grundAusFehler(err);
  }
}

// Ein Versuch, bei Fehlschlag nach pauseMs ein zweiter. Grund nie mit Adresse.
export async function pruefe({ url, fetchImpl, warte, timeoutMs = TIMEOUT_MS, pauseMs = PAUSE_MS }) {
  const erster = await versuch(url, fetchImpl, timeoutMs);
  if (erster === null) return { ergebnis: 'ok', versuche: 1 };
  await warte(pauseMs);
  const zweiter = await versuch(url, fetchImpl, timeoutMs);
  if (zweiter === null) return { ergebnis: 'ok', versuche: 2 };
  return { ergebnis: 'fehler', grund: zweiter, versuche: 2 };
}

export function autorisiert(authHeader, cronSecret) {
  if (typeof cronSecret !== 'string' || cronSecret.length === 0) return false;
  if (typeof authHeader !== 'string') return false;
  const erwartet = Buffer.from(`Bearer ${cronSecret}`);
  const erhalten = Buffer.from(authHeader);
  if (erwartet.length !== erhalten.length) return false;
  return timingSafeEqual(erwartet, erhalten);
}

function zeitUtc(datum) {
  return datum.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function logZeile({ zeit, ergebnis, grund, simulation, alarm, quelle }) {
  const g = grund ? grund.replace(/\s+/g, '_') : '-';
  return `zeit_utc=${zeit} ergebnis=${ergebnis} grund=${g} simulation=${simulation} alarm=${alarm} quelle=${quelle}`;
}

async function sendeAlarm({ webhook, text, fetchImpl }) {
  try {
    const res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const inhalt = (await res.text()).trim();
    return res.status === 200 && inhalt === 'ok' ? 'gesendet' : 'fehlgeschlagen';
  } catch {
    return 'fehlgeschlagen';
  }
}

// Ein Cron-Lauf. Liefert { status, body }; schreibt genau eine Log-Zeile.
// quelle dient nur dem Beleg geplanter Laeufe (Vercel sendet User-Agent vercel-cron/1.0), nicht der Autorisierung.
export async function verarbeite({ authHeader, userAgent, env, fetchImpl, warte, jetzt, log }) {
  const zeit = zeitUtc(jetzt());
  const quelle = typeof userAgent === 'string' && userAgent.startsWith('vercel-cron/') ? 'cron' : 'manuell';

  if (!autorisiert(authHeader, env.CRON_SECRET)) {
    log(logZeile({ zeit, ergebnis: 'abgelehnt', grund: null, simulation: '-', alarm: '-', quelle }));
    return { status: 401, body: { ergebnis: 'abgelehnt' } };
  }

  const simulation = env.HEARTBEAT_SIMULATION === 'instanz-weg' ? 'instanz-weg' : 'aus';
  const ziel = simulation === 'instanz-weg' ? SIMULATIONS_ZIEL : env.N8N_HEALTH_URL;

  const befund = ziel
    ? await pruefe({ url: ziel, fetchImpl, warte })
    : { ergebnis: 'fehler', grund: 'konfiguration', versuche: 0 };

  if (befund.ergebnis === 'ok') {
    log(logZeile({ zeit, ergebnis: 'ok', grund: null, simulation, alarm: '-', quelle }));
    const body = { ergebnis: 'ok' };
    if (simulation !== 'aus') body.simulation = simulation;
    return { status: 200, body };
  }

  const praefix = simulation === 'instanz-weg' ? '[SIMULATION] ' : '';
  const text = `${praefix}Heartbeat: n8n-Instanz nicht erreichbar (${befund.grund}, ${zeit})`;
  const alarm = env.SLACK_WEBHOOK_URL
    ? await sendeAlarm({ webhook: env.SLACK_WEBHOOK_URL, text, fetchImpl })
    : 'nicht-konfiguriert';

  log(logZeile({ zeit, ergebnis: 'fehler', grund: befund.grund, simulation, alarm, quelle }));
  const body = { ergebnis: 'fehler', grund: befund.grund, alarm };
  if (simulation !== 'aus') body.simulation = simulation;
  return { status: 500, body };
}
