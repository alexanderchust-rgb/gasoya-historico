// GasoYa · foto diaria de precios.
// Descarga los precios oficiales del Ministerio, calcula medianas por provincia, empresa y total nacional,
// y las guarda en data/historico.json. Solo se conservan los últimos KEEP_DAYS días.
//
// Uso:  node snapshot.mjs            (descarga del Ministerio)
//       node snapshot.mjs prueba.json (usa un archivo local, para probar)
import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEEP_DAYS = 50; // <-- cambia este número para guardar más o menos días
const OUT = "data/historico.json";
const API_URL =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";
const MIN_STATIONS = 5000; // si salen menos, algo ha ido mal y no se guarda nada
const MIN_BRAND_STATIONS = 10; // solo empresas con al menos tantas gasolineras

const FUEL_FIELDS = {
  g95: "Precio Gasolina 95 E5",
  g98: "Precio Gasolina 98 E5",
  diesel: "Precio Gasoleo A",
  dieselPlus: "Precio Gasoleo Premium",
  glp: "Precio Gases licuados del petróleo",
};

const num = (s) => {
  if (!s) return null;
  const n = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const coord = (s) => {
  const n = parseFloat(String(s ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const r4 = (n) => Math.round(n * 10000) / 10000;

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const stat = (prices) => ({ m: r4(median(prices)), min: r4(Math.min(...prices)), n: prices.length });

/** Convierte la lista del Ministerio en las medianas del día. */
export function summarize(list) {
  const nat = {}, prov = {}, brand = {}, brandStations = {};
  let stations = 0;
  const push = (bucket, key, fuel, price) => ((bucket[key] ??= {})[fuel] ??= []).push(price);
  for (const r of list) {
    if (coord(r["Latitud"]) == null || coord(r["Longitud (WGS84)"]) == null) continue; // sin coordenadas = dato roto
    stations++;
    const p = (r["Provincia"] || "").trim().toUpperCase();
    const b = (r["Rótulo"] || "").trim().toUpperCase();
    if (b) brandStations[b] = (brandStations[b] ?? 0) + 1;
    for (const [fuel, field] of Object.entries(FUEL_FIELDS)) {
      const price = num(r[field]);
      if (price == null || price > 5) continue;
      push(nat, "ES", fuel, price);
      if (p) push(prov, p, fuel, price);
      if (b) push(brand, b, fuel, price);
    }
  }
  const fold = (bucket, keep = () => true) =>
    Object.fromEntries(
      Object.entries(bucket)
        .filter(([k]) => keep(k))
        .map(([k, fuels]) => [k, Object.fromEntries(Object.entries(fuels).map(([f, prices]) => [f, stat(prices)]))]),
    );
  return {
    stations,
    nat: fold(nat).ES ?? {},
    prov: fold(prov),
    brands: fold(brand, (k) => (brandStations[k] ?? 0) >= MIN_BRAND_STATIONS),
  };
}

/** Añade el día y borra los que tengan más de keepDays. today = "YYYY-MM-DD". */
export function addDay(history, today, day, keepDays = KEEP_DAYS) {
  const days = { ...(history?.days ?? {}), [today]: day };
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - (keepDays - 1));
  const cut = limit.toISOString().slice(0, 10);
  const kept = Object.keys(days).filter((d) => d >= cut).sort();
  return { version: 1, keepDays, updated: today, days: Object.fromEntries(kept.map((d) => [d, days[d]])) };
}

const madridToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function download() {
  let lastErr;
  for (let i = 1; i <= 6; i++) {
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: "application/json", "User-Agent": "GasoYa-historico/1.0" },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.error(`Intento ${i}/6 fallido: ${e?.message ?? e}`);
      await new Promise((r) => setTimeout(r, i * 10_000));
    }
  }
  throw lastErr;
}

async function main() {
  const file = process.argv[2];
  const json = file ? JSON.parse(await readFile(file, "utf8")) : await download();
  const day = summarize(json.ListaEESSPrecio ?? []);
  if (day.stations < MIN_STATIONS) throw new Error(`Solo ${day.stations} gasolineras: no se guarda nada.`);
  let history = null;
  try {
    history = JSON.parse(await readFile(OUT, "utf8"));
  } catch {
    /* primera vez */
  }
  const today = madridToday();
  const next = addDay(history, today, day);
  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(next));
  console.log(`OK ${today}: ${day.stations} gasolineras, ${Object.keys(next.days).length} días guardados.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("ERROR:", e?.message ?? e);
    process.exit(1);
  });
}
