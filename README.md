# n8n-heartbeat

Eine Vercel-Cron-Funktion (`api/heartbeat.js`) prüft alle 15 Minuten von außen, ob ein Automations-Server erreichbar ist, und meldet einen Ausfall direkt per Slack, ohne den Server selbst zu brauchen.
Das Repo enthält weder Zugangsdaten noch die Zieladresse; beides steht nur als Vercel-Umgebungsvariable (`N8N_HEALTH_URL`, `CRON_SECRET`, `SLACK_WEBHOOK_URL`).

Der GitHub-Workflow `heartbeat-aussenprobe` ist nur eine manuell startbare Außenprobe ohne Alarmweg. Tests: `npm test`.
