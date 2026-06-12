/**
 * Live GPS simulator — drives every rep around a route in real time so the
 * dashboard Live Tracking map shows vans actually moving (and the Socket.IO
 * `rep.location` feed lights up). Each tick POSTs a single /reps/{id}/location
 * ping per rep, which the backend re-broadcasts over /ws/ops instantly.
 *
 *   node scripts/live-track.mjs                 # 40 km/h, ping every 4s
 *   SPEED=70 TICK=2 node scripts/live-track.mjs # faster + smoother
 *   API=https://host/api/v1 node scripts/live-track.mjs
 *
 * Runs until Ctrl+C. Everyone stays "online" (pinging < 5 min keeps them green).
 */
const BASE = process.env.API || "http://localhost:3100/api/v1";
const ADMIN = { userNumber: "admin", password: "admin1234" };
const SPEED_KMH = Number(process.env.SPEED || 40); // base van speed
const TICK_MS = Number(process.env.TICK || 4) * 1000; // ping cadence
let token = "";
let running = true;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(json.message) ? json.message.join(", ") : json.message;
    throw new Error(`${method} ${path} → ${res.status} ${msg || JSON.stringify(json)}`);
  }
  return json.data ?? json;
}

const DEPOT = { lat: 31.945, lng: 35.928 }; // Amman center
const jitter = (s = 0.00012) => (Math.random() - 0.5) * 2 * s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Metres between two lat/lng points (haversine). */
function metersBetween(a, b) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

/** Point `f` (0..1) of the way from a to b. */
function lerp(a, b, f) {
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

async function main() {
  token = (await api("POST", "/auth/login", ADMIN)).accessToken;
  console.log("✓ logged in");

  const reps = (await api("GET", "/reps?limit=200")).items ?? [];
  const customers = (await api("GET", "/customers?limit=200")).items ?? [];
  if (!reps.length) {
    console.error("✗ no reps — run scripts/mock-data.mjs first");
    return;
  }

  // Build a closed loop of waypoints per rep: depot → their customers → depot.
  const fleet = reps.map((rep, i) => {
    const own = customers
      .filter((c) => c.repId === rep.id && c.latitude && c.longitude)
      .map((c) => ({ lat: Number(c.latitude), lng: Number(c.longitude) }));
    const stops = own.length
      ? own
      : [0, 1, 2, 3].map((k) => ({
          lat: DEPOT.lat + 0.035 * Math.sin((i + k) * 1.7),
          lng: DEPOT.lng + 0.035 * Math.cos((i + k) * 1.3),
        }));
    const start = { lat: DEPOT.lat + jitter(0.004), lng: DEPOT.lng + jitter(0.004) };
    const waypoints = [start, ...stops, start]; // loop back to depot
    return {
      rep,
      name: rep.nameAr || rep.code || rep.id.slice(0, 6),
      waypoints,
      seg: 0, // current segment index
      frac: 0, // progress 0..1 along current segment
      kmh: SPEED_KMH * (0.8 + Math.random() * 0.5), // per-van speed variation
    };
  });
  console.log(`✓ simulating ${fleet.length} vans @ ~${SPEED_KMH} km/h, ping every ${TICK_MS / 1000}s`);
  console.log("  press Ctrl+C to stop\n");

  let ticks = 0;
  while (running) {
    const t0 = Date.now();
    await Promise.all(
      fleet.map(async (v) => {
        // Advance this van by (speed × dt) metres along its loop.
        let advance = (v.kmh * 1000 / 3600) * (TICK_MS / 1000);
        for (let guard = 0; guard < 50 && advance > 0; guard++) {
          const a = v.waypoints[v.seg];
          const b = v.waypoints[v.seg + 1];
          const segLen = Math.max(1, metersBetween(a, b));
          const remaining = segLen * (1 - v.frac);
          if (advance < remaining) {
            v.frac += advance / segLen;
            advance = 0;
          } else {
            advance -= remaining;
            v.seg = (v.seg + 1) % (v.waypoints.length - 1);
            v.frac = 0;
          }
        }
        const a = v.waypoints[v.seg];
        const b = v.waypoints[v.seg + 1];
        const pos = lerp(a, b, v.frac);
        try {
          await api("POST", `/reps/${v.rep.id}/location`, {
            lat: Number((pos.lat + jitter()).toFixed(6)),
            lng: Number((pos.lng + jitter()).toFixed(6)),
            accuracyM: 4 + Math.round(Math.random() * 12),
          });
        } catch (e) {
          console.log(`  ✗ ${v.name}: ${e.message}`);
        }
      }),
    );
    ticks++;
    process.stdout.write(
      `\r⟳ tick ${ticks} — ${fleet.length} vans pinged @ ${new Date().toLocaleTimeString()}   `,
    );
    const elapsed = Date.now() - t0;
    await sleep(Math.max(0, TICK_MS - elapsed));
  }
}

process.on("SIGINT", () => {
  running = false;
  console.log("\n\n✋ stopped — vans will go idle in 5 min, offline in 30.");
  process.exit(0);
});

main().catch((e) => {
  console.error("\n❌ FAILED:", e.message);
  process.exit(1);
});
