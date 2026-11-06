/** Smoke test des routes HTTP : contract de données consommées par l'UI. */
import { cfg } from "../config.js";

const B = `http://127.0.0.1:${cfg.port}`;
const ADMIN = { "content-type": "application/json", "x-admin-token": cfg.adminToken };

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${B}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> http ${r.status}`);
  return (await r.json()) as unknown;
}

function size(o: unknown): number {
  return Array.isArray(o) ? o.length : -1;
}

async function main(): Promise<void> {
  const ov = (await get("/api/overview")) as Record<string, unknown>;
  console.log(
    `[overview] joueurs=${size(ov.players)} étatsConteneurs=${size(ov.containerStates)}` +
      ` incidentsOuverts=${size(ov.incidentsOpen)} récents=${size(ov.recent)}` +
      ` curseurs=${size(ov.cursors)} dernierCycle=${String(ov.lastCycleAt)} sse=${String(ov.sseClients)} faux=${String(ov.fakeUsers)}`
  );

  const houses = (await get("/api/houses")) as Record<string, unknown>[];
  console.log(`[houses] n=${houses.length}`, JSON.stringify(houses[0]));
  const maison = houses.filter((h) => h.kind === "house").length;
  const territoire = houses.filter((h) => h.kind === "territory").length;
  const badExtent = houses.filter((h) => Number(h.xmax) < Number(h.xmin));
  console.log(`[houses intégrité] maison=${maison} territoire=${territoire} emprisesInversées=${badExtent.length}`);

  for (const uid of [1, 14, 40]) {
    const p = (await get(`/api/players/${uid}`)) as Record<string, unknown>;
    console.log(
      `[players/${uid}] nom=${String((p.base as Record<string, unknown>).name)}` +
        ` sessions=${size(p.sessions)} usage=${size(p.usage)} incidents=${size(p.incidents)}` +
        ` chats=${size(p.chats)} commandes=${size(p.commands)} maisons=${size(p.homes)}`
    );
  }

  const plist = (await get("/api/players?q=Anony&limit=50")) as Record<string, unknown>[];
  console.log(`[players recherche "Anony"] n=${plist.length}`, JSON.stringify(plist.slice(0, 2)));

  const worlds = (await get("/api/worlds")) as Record<string, unknown>[];
  console.log(`[worlds] ${JSON.stringify(worlds)}`);

  const scores = (await get("/api/scores?uid=40&days=90")) as { rows: Record<string, unknown>[]; day: number };
  console.log(`[scores uid=40 jours=${scores.rows.length}] derniers=${JSON.stringify(scores.rows.slice(-2))}`);

  const cont = (await get("/api/containers?state=owned&limit=3")) as Record<string, unknown>[];
  console.log(`[containers owned] n=${cont.length}`);
  for (const c of cont.slice(0, 2)) {
    console.log(`  ${String(c.key)} owner=${String(c.owner_name)} score=${String(c.score)} locked=${String(c.locked)} vol=${String(c.volume)}`);
  }

  const inc = (await get("/api/incidents?limit=5")) as Record<string, unknown>;
  console.log(`[incidents] items=${size(inc.items)} total=${String(inc.total)}`);

  const map = (await get("/api/map?wid=1&x0=-700&x1=-260&z0=-480&z1=-40")) as Record<string, unknown>;
  console.log(
    `[map bbox 440x440] clusters=${size(map.clusters)} conteneurs=${size(map.containers)} chunks=${size(map.chunks)} tooWide=${String(map.tooWide)}`
  );

  const big = (await get("/api/map?wid=1&x0=-9000&x1=9000&z0=-400&z1=400")) as Record<string, unknown>;
  console.log(`[map trop large] tooWide=${String(big.tooWide)}`);

  const firstItem = (inc.items as Record<string, unknown>[])[0];
  if (firstItem) {
    const full = (await get(`/api/incidents/${String(firstItem.id)}`)) as Record<string, unknown>;
    const evType = typeof (full as { evidence: unknown }).evidence;
    console.log(`[incident ${String(full.id)} détail] typePreuve=${evType} acteur=${String(full.actor_name)} victime=${String(full.victim_name)} monde=${String(full.world_name)}`);
  }

  // --- accusation admin (statut + note) puis retour à "nouvel" ---
  const patchRes = await fetch(`${B}/api/incidents/${String(firstItem.id)}`, {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ status: "seen", note: "accusété (validation smoke)" }),
  });
  console.log(`[incident ${String(firstItem.id)} accusation] http ${patchRes.status} ${JSON.stringify(await patchRes.json())}`);

  const afterPatch = (await get(`/api/incidents/${String(firstItem.id)}`)) as Record<string, unknown>;
  console.log(`[après accusation] statut=${String(afterPatch.status)} note=${String(afterPatch.note)}`);

  await fetch(`${B}/api/incidents/${String(firstItem.id)}`, { method: "POST", headers: ADMIN, body: JSON.stringify({ status: "new" }) });

  const csvRes = await fetch(`${B}/api/export.csv`);
  const csv = await csvRes.text();
  const lines = csv.split("\n");
  console.log(`[export.csv] lignes=${lines.length} en-tête=${lines[0]} type=${csvRes.headers.get("content-type")}`);

  const csvTheft = (await (await fetch(`${B}/api/export.csv?kind=theft`)).text()).split("\n");
  console.log(`[export.csv vol] lignes=${csvTheft.length}`);

  const st = (await get("/api/settings")) as { settings: Record<string, unknown>; keys: string[] };
  console.log(`[settings] clés=${JSON.stringify(Object.keys(st.settings))}`);

  const cyc = await fetch(`${B}/api/cycle/run`, { method: "POST", headers: ADMIN, body: "{}" });
  console.log(`[cycle/run admin] http ${cyc.status} ${JSON.stringify(await cyc.json())}`);

  const noAuth = await fetch(`${B}/api/cycle/run`, { method: "POST" });
  console.log(`[cycle/run sans token] http ${noAuth.status} (attendu 401)`);

  // SSE : hello, puis un cycle complet dans la limite de temps.
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 115_000);
  const sseRes = await fetch(`${B}/api/stream`, { headers: { accept: "text/event-stream" }, signal: ctl.signal });
  console.log(`[sse] http ${sseRes.status} type=${sseRes.headers.get("content-type")}`);
  const reader = sseRes.body!.getReader();
  let seen = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
      const events = [...seen.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
      const cycles = events.filter((e) => e === "cycle").length;
      console.log(`[sse flux] événements=[${events.join(", ")}] cycles=${cycles}`);
      if (cycles >= 2) break;
    }
  } catch (e) {
    console.log(`[sse fin] ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error("[smoke] échec :", (e as Error).message);
  process.exit(1);
});
