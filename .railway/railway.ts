import { defineRailway, preserve, project, service, volume } from "railway/iac";

/*
 * Stock-out Watch on Railway (ADR 0012: one instance, own volume).
 * Region: Singapore, closest to India and to Performity. Static outbound IPs (Pro plan) are per
 * region, so the region is fixed before Performity allow-lists our IP.
 * Secrets are never written here: preserve() keeps the values set in the Railway dashboard.
 */
const REGION = "asia-southeast1-eqsg3a";

export default defineRailway(() => {
  const data = volume("web-volume", {
    region: REGION,
    sizeMB: 5000,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });
  const web = service("web", {
    replicas: { [REGION]: 1 },                 // exactly one: pulls must never run twice
    volumeMounts: { "/data": data },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    env: {
      ADMIN_PASSWORD: preserve(),
      RAILWAY_RUN_UID: preserve(),
    },
  });
  return project("stock-watch", { resources: [web, data] });
});
