// Vercel-Cron-Funktion (vercel.json: alle 15 Minuten). Logik in lib/pruefung.js.
import { verarbeite } from '../lib/pruefung.js';

export async function GET(request) {
  const { status, body } = await verarbeite({
    authHeader: request.headers.get('authorization'),
    userAgent: request.headers.get('user-agent'),
    env: process.env,
    fetchImpl: fetch,
    warte: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    jetzt: () => new Date(),
    log: (zeile) => console.log(zeile),
  });
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
