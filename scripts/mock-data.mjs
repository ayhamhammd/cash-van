/**
 * Mock-data generator — drives the REAL API so the full workflow runs
 * (voucher numbering, stock balances, stock guards, collections, routes).
 *
 *   node scripts/mock-data.mjs            # against http://localhost:3100/api/v1
 *   API=https://host/api/v1 node scripts/mock-data.mjs
 *
 * Safe to re-run: customers are only topped up to a target count; stock/vouchers
 * are additive.
 */
const BASE = process.env.API || "http://localhost:3100/api/v1";
const ADMIN = { userNumber: "admin", password: "admin1234" };
let token = "";

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
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];
const svg = (label, color) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' rx='12' fill='${color}'/><text x='40' y='50' font-size='34' fill='white' text-anchor='middle' font-family='sans-serif'>${label}</text></svg>`,
  );

async function main() {
  token = (await api("POST", "/auth/login", ADMIN)).accessToken;
  console.log("✓ logged in");

  const products = (await api("GET", "/products?limit=200")).items ?? [];
  const units = await api("GET", "/units");
  const reps = (await api("GET", "/reps?limit=200")).items ?? [];
  const regions = (await api("GET", "/regions")).items ?? [];
  const users = (await api("GET", "/users?page=1&limit=200")).items ?? [];
  const userById = new Map(users.map((u) => [u.id, u.userNumber]));
  const MAIN = "MAIN";
  const pk6 = units.find((u) => u.code === "PK6") || units.find((u) => u.baseQty > 1);
  console.log(`  ${products.length} products, ${reps.length} reps, ${regions.length} regions`);

  // ---- 1) Items: tax + image + a unit (PK6) -------------------------------
  const colors = ["#4F8EF7", "#22C97B", "#F5A623", "#9B59F7", "#E0556E", "#13B5B1"];
  let n = 0;
  for (const p of products) {
    const initial = (p.nameEn || p.name || "?").slice(0, 1).toUpperCase();
    try {
      await api("PATCH", `/products/${p.id}`, {
        taxRate: 0.16,
        imageUrl: svg(initial, pick(colors, n++)),
      });
    } catch (e) {
      console.log("  img/tax skip", p.itemNumber, e.message);
    }
    if (pk6) {
      const attached = await api("GET", `/products/${p.id}/units`).catch(() => []);
      if (!attached.some((iu) => iu.unitId === pk6.id)) {
        const salePrice = ((p.price / 1000) * pk6.baseQty * 0.95).toFixed(3);
        await api("POST", `/products/${p.id}/units`, {
          unitId: pk6.id,
          barcode: `U-${p.itemNumber}-${pk6.code}`.replace(/\s/g, ""),
          salePrice,
          qty: pk6.baseQty,
        }).catch(() => {});
      }
    }
  }
  console.log(`✓ items updated (tax + image + ${pk6?.code ?? "unit"})`);

  // ---- 2) Stock MAIN (IN voucher) so sales have stock ---------------------
  const stockLines = products.slice(0, 40).map((p) => ({
    itemNumber: p.itemNumber,
    itemName: p.nameEn || p.name,
    itemQty: "1000",
    unitPrice: "0",
    storeNumber: MAIN,
  }));
  if (stockLines.length) {
    const inV = await api("POST", "/vouchers", {
      transKind: "IN",
      userCode: "admin",
      isPosted: true,
      transactions: stockLines,
    });
    console.log(`✓ stocked MAIN via ${inV.voucherNumber} (${stockLines.length} items × 1000)`);
  }

  // ---- 3) Customers with full info ---------------------------------------
  const existing = (await api("GET", "/customers?limit=200")).items ?? [];
  const TARGET = 8;
  const names = [
    ["بقالة النور", "Al Noor Grocery", "Amman", "CASH"],
    ["سوبرماركت الوفاء", "Al Wafa Supermarket", "Amman", "CREDIT"],
    ["ميني ماركت الشروق", "Shorouq Mini Market", "Zarqa", "CASH"],
    ["بقالة السلام", "Salam Store", "Irbid", "RETAIL"],
    ["سوبرماركت المدينة", "City Supermarket", "Amman", "WHOLESALE"],
    ["دكان البركة", "Baraka Shop", "Zarqa", "CASH"],
    ["ماركت الأمانة", "Amana Market", "Irbid", "CREDIT"],
    ["بقالة الرحمة", "Rahma Grocery", "Amman", "CASH"],
  ];
  const created = [];
  for (let i = existing.length; i < TARGET; i++) {
    const [ar, en, city, type] = names[i % names.length];
    const rep = pick(reps, i);
    const region = pick(regions, i);
    const lat = (31.95 + (Math.random() - 0.5) * 0.18).toFixed(6);
    const lng = (35.93 + (Math.random() - 0.5) * 0.18).toFixed(6);
    const c = await api("POST", "/customers", {
      customerName: en,
      nameAr: ar,
      nameEn: en,
      phone: `+9627${90000000 + i * 111111}`,
      city,
      addressAr: `${city} - شارع رئيسي ${i + 1}`,
      customerType: type,
      repId: rep?.id,
      regionId: region?.id,
      latitude: lat,
      longitude: lng,
    });
    created.push(c);
    console.log(`  + customer ${c.customerNumber} ${en}`);
  }
  const customers = [...existing, ...created];
  console.log(`✓ customers: ${customers.length} (created ${created.length})`);

  // ---- 4) Vouchers (SALE/RETURN/ORDER) + collections + visits ------------
  const sellable = products.slice(0, 12);
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    const rep = reps.find((r) => r.id === c.repId) || pick(reps, i);
    const userCode = (rep && userById.get(rep.userId)) || "admin";

    const lines = [];
    for (let j = 0; j < 2 + (i % 3); j++) {
      const p = pick(sellable, i + j);
      lines.push({
        itemNumber: p.itemNumber,
        itemName: p.nameEn || p.name,
        itemQty: String(2 + (j % 4)),
        unitPrice: (p.price / 1000).toFixed(3),
        storeNumber: MAIN,
      });
    }
    let sale = null;
    try {
      // Pay ~ the gross (lines + 16% tax); every 3rd customer pays half by cheque.
      const gross = lines.reduce((t, l) => t + Number(l.itemQty) * Number(l.unitPrice), 0) * 1.16;
      const cheque = i % 3 === 1;
      sale = await api("POST", "/vouchers", {
        transKind: "SALE",
        userCode,
        customerNumber: c.customerNumber,
        isPosted: true,
        transactions: lines,
        payments: [
          { amount: (gross * (cheque ? 0.5 : 1)).toFixed(3), paymentType: "CASH" },
          ...(cheque ? [{ amount: (gross * 0.5).toFixed(3), paymentType: "CHEQUE" }] : []),
        ],
      });
    } catch (e) {
      console.log("  SALE skip", c.customerNumber, e.message);
    }

    if (sale && i % 3 === 0) {
      await api("POST", "/vouchers", {
        transKind: "RETURN",
        userCode,
        referenceVoucherNumber: sale.voucherNumber,
        isPosted: true,
        transactions: [
          { itemNumber: lines[0].itemNumber, itemName: lines[0].itemName, itemQty: "1", unitPrice: lines[0].unitPrice },
        ],
      }).catch((e) => console.log("  RETURN skip", e.message));
    }
    if (i % 2 === 0) {
      const p = pick(sellable, i);
      await api("POST", "/vouchers", {
        transKind: "ORDER",
        userCode,
        customerNumber: c.customerNumber,
        isPosted: true,
        transactions: [
          { itemNumber: p.itemNumber, itemName: p.nameEn || p.name, itemQty: "6", unitPrice: (p.price / 1000).toFixed(3), storeNumber: MAIN },
        ],
      }).catch((e) => console.log("  ORDER skip", e.message));
    }
    if (rep) {
      await api("POST", "/collections", {
        repId: rep.id,
        customerId: c.id,
        amount: 8000 + i * 4500,
        method: "cash",
      }).catch((e) => console.log("  collection skip", e.message));
      await api("POST", `/customers/${c.id}/visits`, {
        repId: rep.id,
        hadSale: !!sale,
        visitNote: "Routine visit + restock",
        lat: Number(c.latitude) || 31.95,
        lng: Number(c.longitude) || 35.93,
      }).catch(() => {});
    }
  }
  console.log("✓ vouchers + collections + visits created");

  // ---- 5) Routes per rep (today) -----------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  for (const rep of reps) {
    const repCustomers = customers.filter((c) => c.repId === rep.id).slice(0, 8);
    if (!repCustomers.length) continue;
    await api("POST", "/routes", {
      repId: rep.id,
      planDate: today,
      stops: repCustomers.map((c, idx) => ({ customerId: c.id, stopOrder: idx + 1, estDurationMin: 20 })),
    })
      .then(() => console.log(`  route ${rep.code || rep.id}: ${repCustomers.length} stops`))
      .catch((e) => console.log("  route skip", rep.code, e.message));
  }

  // ---- 6) GPS trails per rep (live tracking) ------------------------------
  // A realistic working day: depot → each assigned customer → onward, pings
  // every ~2 min with road-ish jitter. End time varies per rep so the map
  // shows a mix of online / idle / offline statuses.
  const DEPOT = { lat: 31.945, lng: 35.928 };
  const jitter = (scale = 0.0008) => (Math.random() - 0.5) * 2 * scale;
  const dayStart = new Date();
  dayStart.setHours(8, 0, 0, 0);

  for (let i = 0; i < reps.length; i++) {
    const rep = reps[i];
    // Waypoints: depot + the rep's customers (fallback: a loop around Amman).
    const own = customers
      .filter((c) => c.repId === rep.id && c.latitude && c.longitude)
      .map((c) => ({ lat: Number(c.latitude), lng: Number(c.longitude) }));
    const loop = own.length
      ? own
      : [0, 1, 2, 3].map((k) => ({
          lat: DEPOT.lat + 0.03 * Math.sin((i + k) * 1.7) + jitter(0.01),
          lng: DEPOT.lng + 0.03 * Math.cos((i + k) * 1.3) + jitter(0.01),
        }));
    const waypoints = [
      { lat: DEPOT.lat + jitter(0.004), lng: DEPOT.lng + jitter(0.004) },
      ...loop,
    ];

    // Status mix: 1/3 online (last ping now), 1/3 idle (~15 min ago), 1/3 offline (~2 h ago).
    const endMs =
      i % 3 === 0
        ? Date.now()
        : i % 3 === 1
          ? Date.now() - 15 * 60_000
          : Date.now() - 2 * 60 * 60_000;
    const startMs = dayStart.getTime();
    if (endMs <= startMs) continue; // very early morning runs

    // Interpolate the route over the time window, one ping every ~2 minutes.
    const totalPings = Math.min(480, Math.max(20, Math.floor((endMs - startMs) / 120_000)));
    const points = [];
    for (let p = 0; p < totalPings; p++) {
      const tFrac = p / (totalPings - 1);
      const seg = tFrac * (waypoints.length - 1);
      const s = Math.min(waypoints.length - 2, Math.floor(seg));
      const f = seg - s;
      const a = waypoints[s];
      const b = waypoints[s + 1];
      points.push({
        lat: Number((a.lat + (b.lat - a.lat) * f + jitter()).toFixed(6)),
        lng: Number((a.lng + (b.lng - a.lng) * f + jitter()).toFixed(6)),
        accuracyM: 5 + Math.round(Math.random() * 20),
        recordedAt: new Date(startMs + tFrac * (endMs - startMs)).toISOString(),
      });
    }

    // Bulk endpoint accepts ≤500 points per call.
    for (let off = 0; off < points.length; off += 500) {
      await api("POST", `/reps/${rep.id}/location/bulk`, {
        points: points.slice(off, off + 500),
      }).catch((e) => console.log("  trail skip", rep.code || rep.id, e.message));
    }
    console.log(
      `  trail ${rep.code || rep.id}: ${points.length} pings (${i % 3 === 0 ? "online" : i % 3 === 1 ? "idle" : "offline"})`,
    );
  }
  console.log("✓ GPS trails generated");

  // ---- 7) Backdated 30-day sales history (trend charts / leaderboards) ----
  // Skipped when history already exists (idempotence guard on old vouchers).
  const guardDate = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const oldSales = await api(
    "GET",
    `/vouchers?transKind=SALE&dateTo=${guardDate}`,
  ).catch(() => []);
  if ((oldSales?.length ?? 0) > 0) {
    console.log("✓ sales history already present — skipped");
  } else {
    let histCount = 0;
    for (let d = 30; d >= 1; d--) {
      const day = new Date();
      day.setDate(day.getDate() - d);
      day.setHours(10 + (d % 6), 15, 0, 0);
      const perDay = 1 + ((d * 7) % 3); // 1–3 sales/day, deterministic
      for (let s = 0; s < perDay; s++) {
        const c = pick(customers, d + s);
        const rep = reps.find((r) => r.id === c.repId) || pick(reps, d + s);
        const userCode = (rep && userById.get(rep.userId)) || "admin";
        const lines = [];
        for (let j = 0; j < 1 + ((d + s) % 3); j++) {
          const p = pick(sellable, d + s + j);
          lines.push({
            itemNumber: p.itemNumber,
            itemName: p.nameEn || p.name,
            itemQty: String(1 + ((d + j) % 5)),
            unitPrice: (p.price / 1000).toFixed(3),
            storeNumber: MAIN,
          });
        }
        const gross =
          lines.reduce((t, l) => t + Number(l.itemQty) * Number(l.unitPrice), 0) * 1.16;
        const cheque = (d + s) % 4 === 0;
        const iso = day.toISOString();
        await api("POST", "/vouchers", {
          transKind: "SALE",
          userCode,
          customerNumber: c.customerNumber,
          isPosted: true,
          inDate: iso,
          transactions: lines,
          payments: [
            { amount: (gross * (cheque ? 0.5 : 1)).toFixed(3), paymentType: "CASH", paymentDate: iso },
            ...(cheque
              ? [{ amount: (gross * 0.5).toFixed(3), paymentType: "CHEQUE", paymentDate: iso }]
              : []),
          ],
        })
          .then(() => histCount++)
          .catch((e) => console.log("  hist skip", e.message));
      }
    }
    console.log(`✓ sales history seeded (${histCount} backdated vouchers)`);
  }

  console.log("\n✅ DONE — mock data generated");
}

main().catch((e) => {
  console.error("\n❌ FAILED:", e.message);
  process.exit(1);
});
