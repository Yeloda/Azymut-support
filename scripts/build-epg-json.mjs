// scripts/build-epg-json.mjs
//
// Génère le guide TV que l'application consomme, à partir du flux XMLTV
// epgshare01 FR1.
//
// POURQUOI CE SCRIPT EXISTE
// -------------------------
// L'application parsait elle-même un XMLTV de 5,8 Mo. Deux problèmes :
//
//   1. `XMLParser.parse()` est synchrone et non interruptible. Pendant toute
//      sa durée le thread JS est gelé — d'où les délais de 4 s, le passage par
//      `InteractionManager` et tout l'échafaudage de `useEPG.ts`.
//   2. La source utilisée (open-epg france1.xml) ne contient QUE
//      `<title>`, `<sub-title>` et `<episode-num>`. Ni image, ni description,
//      ni catégorie. Le code qui les extrayait ne produisait que des
//      `undefined`.
//
// La source retenue ici corrige le second point (99 % des programmes portent
// une image, une description et une catégorie) mais aggrave le premier : elle
// pèse 45 Mo décompressés. La parser sur mobile est hors de question.
//
// Ce script fait donc le travail UNE FOIS, en CI, et publie ~1,5 Mo de JSON
// déjà filtré, déjà trié, déjà normalisé. L'application n'a plus qu'un
// `JSON.parse()` à faire.
//
// CONTRAINTE IMPORTANTE
// ---------------------
// Ce fichier n'importe RIEN de `src/`. Il est déployé tel quel dans le dépôt
// Azymut-support, qui n'a pas accès au code de l'application. Voir
// `deploy/azymut-support/README.md`. La table `CHANNELS` ci-dessous y est donc
// dupliquée ; `scripts/build-epg-json.test.mjs` vérifie qu'elle ne dérive pas
// de `EPG_CHANNEL_MAPPING`.

import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export const SOURCE_URL =
  'https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz';

/** En dessous, ce n'est pas un guide mais une page d'erreur. */
const MIN_ARCHIVE_BYTES = 1_000_000;

/**
 * Chaînes publiées, et identifiant sous lequel l'application les demande.
 *
 * `epgId` est l'identifiant HISTORIQUE, celui que `getEPGChannelId()` renvoie
 * déjà. Le JSON est donc indexé exactement comme l'application interroge —
 * aucun composant, aucun mappage côté app n'a besoin de changer.
 *
 * `match` sert à retrouver la chaîne dans le flux. La source agrège quatre
 * fournisseurs (SFR, Télérama, france.tv, M6) et publie donc plusieurs entrées
 * pour une même chaîne, avec des identifiants qui ne diffèrent parfois que par
 * un point (`Arte.fr`, `Arte..fr`, `Arte...fr` — vestiges d'espaces en fin de
 * nom). On ne fige pas ces identifiants : `resolveChannels()` compare des noms
 * normalisés et retient la variante la mieux fournie. Un point de plus ou de
 * moins demain ne casse rien.
 *
 * `match` ne s'écarte du nom courant que lorsque la source nomme la chaîne
 * autrement — sans quoi la normalisation seule échouerait.
 */
export const CHANNELS = [
  // Généralistes
  { epgId: 'TF1.fr', match: 'TF1' },
  { epgId: 'France 2.fr', match: 'France 2' },
  { epgId: 'France 3.fr', match: 'France 3' },
  { epgId: 'M6.fr', match: 'M6' },
  { epgId: 'Canal+.fr', match: 'Canal+' },

  // Jeunesse
  { epgId: 'France 4.fr', match: 'France 4' },
  { epgId: 'Gulli.fr', match: 'Gulli' },

  // Culture
  { epgId: 'France 5.fr', match: 'France 5' },
  { epgId: 'Arte.fr', match: 'Arte' },
  { epgId: 'RMC Decouverte.fr', match: 'RMC Découverte' },

  // Info
  { epgId: 'LCP 100%.fr', match: 'LCP-AN-PS' },
  { epgId: 'BFMTV.fr', match: 'BFM TV' },
  { epgId: 'CNEWS.fr', match: 'CNews' },
  { epgId: 'LCI - La Chaîne Info.fr', match: 'LCI' },
  { epgId: 'Franceinfo.fr', match: 'France info' },

  // Divertissement
  { epgId: 'W9.fr', match: 'W9' },
  { epgId: 'TMC.fr', match: 'TMC' },
  { epgId: 'TFX.fr', match: 'TFX' },
  { epgId: 'CSTAR.fr', match: 'CStar' },
  { epgId: 'TF1 Series Films.fr', match: 'TF1 Séries-Films' },
  { epgId: '6ter.fr', match: '6ter' },
  { epgId: 'RMC Story.fr', match: 'RMC Story' },
  { epgId: 'Cherie 25.fr', match: 'Chérie 25' },

  // Sport
  { epgId: 'Eurosport 1.fr', match: 'Eurosport 1' },
  { epgId: 'Eurosport 2.fr', match: 'Eurosport 2' },
  { epgId: 'Infosport+.fr', match: 'Infosport+' },
  { epgId: 'RMC Sport 1.fr', match: 'RMC Sport 1' },
  { epgId: 'RMC Sport 2.fr', match: 'RMC Sport Live 2' },
  { epgId: 'beIN SPORTS 1.fr', match: 'beIN SPORTS 1' },
  { epgId: 'beIN SPORTS 2.fr', match: 'beIN SPORTS 2' },
  { epgId: 'beIN SPORTS 3.fr', match: 'beIN SPORTS 3' },
  { epgId: 'Canal+ Sport.fr', match: 'Canal+ Sport' },
  { epgId: "L'Equipe.fr", match: "La chaine l'Équipe" },

  // Chaînes récentes
  { epgId: 'T18.fr', match: 'T18' },
  { epgId: 'NOVO19.fr', match: 'NOVO19' },
];

/**
 * Réduit un identifiant de chaîne à sa forme comparable.
 *
 * Absorbe les écarts de casse, d'accent et de ponctuation entre les
 * fournisseurs agrégés : `RMC.Découverte.fr`, `RMC Decouverte.fr` et
 * `RMC-DECOUVERTE.fr` donnent tous `rmcdecouverte`. Le `+` est conservé, seul
 * signe distinctif entre `Canal+ Sport` et `Canal Sport`.
 */
export function normalizeChannelId(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.fr$/, '')
    .replace(/[^a-z0-9+]/g, '');
}

/** Format XMLTV : `YYYYMMDDHHMMSS +TZOFFSET` → secondes epoch. */
export function parseXMLTVDate(value) {
  if (typeof value !== 'string' || value.length < 14) return null;

  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(4, 6), 10) - 1;
  const day = Number.parseInt(value.slice(6, 8), 10);
  const hour = Number.parseInt(value.slice(8, 10), 10);
  const minute = Number.parseInt(value.slice(10, 12), 10);
  const second = Number.parseInt(value.slice(12, 14), 10);

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;

  const offset = value.slice(14).match(/([+-])(\d{2})(\d{2})/);
  let offsetMinutes = 0;
  if (offset) {
    const sign = offset[1] === '+' ? 1 : -1;
    offsetMinutes =
      sign *
      (Number.parseInt(offset[2], 10) * 60 + Number.parseInt(offset[3], 10));
  }

  const utc = Date.UTC(year, month, day, hour, minute, second);
  return Math.round((utc - offsetMinutes * 60_000) / 1000);
}

/** Un nœud fast-xml-parser peut être une chaîne, un objet, ou un tableau. */
export function textOf(node) {
  if (node === undefined || node === null) return undefined;
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'string') return node.trim() || undefined;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') return textOf(node['#text']);
  return undefined;
}

/**
 * Normalise une URL d'image pour un usage mobile.
 *
 * La source déclare 114 714 de ses 139 946 images en `http://` (CDN SFR).
 * App Transport Security sur iOS et le blocage du trafic en clair sur Android
 * les rejetteraient toutes. Ces hôtes répondent en `https` — vérifié — donc
 * une simple réécriture suffit.
 *
 * Écarte au passage les URL malformées de la source : Télérama publie des
 * entrées où deux URL ont été concaténées
 * (`https://television.telerama.frhttps://focus.telerama.fr/...`).
 */
export function normalizeImageUrl(src) {
  if (typeof src !== 'string') return undefined;

  const url = src.trim();
  if (!url) return undefined;

  // Deux schémas dans la même chaîne : concaténation ratée côté source.
  const second = url.indexOf('://', url.indexOf('://') + 3);
  if (second !== -1) return undefined;

  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return undefined;
}

/** Première image exploitable d'un programme. */
function pickIcon(node) {
  const icons = Array.isArray(node) ? node : node ? [node] : [];

  for (const icon of icons) {
    const url = normalizeImageUrl(icon?.['@_src']);
    if (url) return url;
  }
  return undefined;
}

/**
 * `episode-num` en clair.
 *
 * La source publie deux systèmes. `onscreen` donne « S20 E13 », directement
 * affichable ; `xmltv_ns` donne « 19..12. », qu'il faudrait décoder et
 * réindexer. On ne garde que le premier : le second n'a jamais été affiché
 * autrement que brut.
 */
function pickEpisode(node) {
  const entries = Array.isArray(node) ? node : node ? [node] : [];

  for (const entry of entries) {
    if (entry?.['@_system'] === 'onscreen') {
      const text = textOf(entry);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Associe chaque chaîne de l'app à la meilleure entrée du flux.
 *
 * La source publiant plusieurs variantes par chaîne (une par fournisseur
 * agrégé), on retient celle qui porte le plus de programmes illustrés, puis le
 * plus de programmes. Une variante à zéro programme — il en existe — n'est
 * jamais retenue au détriment d'une variante fournie.
 */
export function resolveChannels(feedChannels, programCounts) {
  const byNormalized = new Map();

  for (const [id, displayName] of feedChannels) {
    const key = normalizeChannelId(id);
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push({ id, displayName });
  }

  const resolved = [];
  const missing = [];

  for (const channel of CHANNELS) {
    const candidates = byNormalized.get(normalizeChannelId(channel.match)) ?? [];

    let best = null;
    for (const candidate of candidates) {
      const counts = programCounts.get(candidate.id) ?? { total: 0, withIcon: 0 };
      if (
        !best ||
        counts.withIcon > best.counts.withIcon ||
        (counts.withIcon === best.counts.withIcon && counts.total > best.counts.total)
      ) {
        best = { ...candidate, counts };
      }
    }

    if (!best || best.counts.total === 0) {
      missing.push(channel.epgId);
      continue;
    }

    resolved.push({ epgId: channel.epgId, feedId: best.id, displayName: best.displayName });
  }

  return { resolved, missing };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['channel', 'programme', 'icon', 'episode-num'].includes(name),
});

/** Construit le guide à partir du XML brut. */
export function buildGuide(xml, { now = Date.now() } = {}) {
  const parsed = parser.parse(xml);
  const tv = parsed?.tv ?? parsed;

  const feedChannels = (tv?.channel ?? []).map((channel) => [
    channel?.['@_id'],
    textOf(channel?.['display-name']),
  ]).filter(([id]) => typeof id === 'string');

  const rawPrograms = tv?.programme ?? [];

  // Premier passage : compter, pour départager les variantes d'une chaîne.
  const programCounts = new Map();
  for (const program of rawPrograms) {
    const feedId = program?.['@_channel'];
    if (typeof feedId !== 'string') continue;

    let counts = programCounts.get(feedId);
    if (!counts) programCounts.set(feedId, (counts = { total: 0, withIcon: 0 }));

    counts.total += 1;
    if (program.icon) counts.withIcon += 1;
  }

  const { resolved, missing } = resolveChannels(feedChannels, programCounts);
  const feedToEpg = new Map(resolved.map((c) => [c.feedId, c.epgId]));

  const channels = {};
  for (const channel of resolved) {
    channels[channel.epgId] = { name: channel.displayName ?? channel.epgId, p: [] };
  }

  // Un guide n'a aucune raison de traîner l'avant-veille : le cache client est
  // rafraîchi quotidiennement et l'app ne remonte jamais dans le passé.
  const floor = Math.round(now / 1000) - 12 * 3600;

  for (const program of rawPrograms) {
    const epgId = feedToEpg.get(program?.['@_channel']);
    if (!epgId) continue;

    const start = parseXMLTVDate(program['@_start']);
    const stop = parseXMLTVDate(program['@_stop']);
    if (start === null || stop === null || stop <= start || stop < floor) continue;

    const title = textOf(program.title);
    if (!title) continue;

    const entry = { s: start, e: stop, t: title };

    const subTitle = textOf(program['sub-title']);
    if (subTitle && subTitle !== title) entry.st = subTitle;

    const description = textOf(program.desc);
    if (description) entry.d = description;

    const category = textOf(program.category);
    if (category) entry.c = category;

    const icon = pickIcon(program.icon);
    if (icon) entry.i = icon;

    const episode = pickEpisode(program['episode-num']);
    if (episode) entry.n = episode;

    channels[epgId].p.push(entry);
  }

  for (const channel of Object.values(channels)) {
    channel.p.sort((a, b) => a.s - b.s);
  }

  return {
    guide: {
      v: 1,
      generatedAt: new Date(now).toISOString(),
      source: 'epgshare01/FR1',
      channels,
    },
    missing,
  };
}

/**
 * Refuse de publier un guide vide ou amputé.
 *
 * Un JSON valide mais creux est plus dangereux qu'un échec : il écraserait sur
 * GitHub Pages un guide correct, et les clients le mettraient en cache pour
 * vingt-quatre heures. Mieux vaut laisser en ligne celui de la veille.
 */
export function assertUsable({ guide, missing }) {
  const problems = [];

  if (missing.length > 0) {
    problems.push(`chaînes introuvables dans le flux : ${missing.join(', ')}`);
  }

  const empty = Object.entries(guide.channels)
    .filter(([, channel]) => channel.p.length === 0)
    .map(([epgId]) => epgId);

  if (empty.length > 0) {
    problems.push(`chaînes sans aucun programme : ${empty.join(', ')}`);
  }

  const total = Object.values(guide.channels).reduce((n, c) => n + c.p.length, 0);
  if (total < 2000) {
    problems.push(`seulement ${total} programmes au total (attendu : plusieurs milliers)`);
  }

  if (problems.length > 0) {
    throw new Error(`Guide inexploitable :\n  - ${problems.join('\n  - ')}`);
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} sur ${url}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());

  // Le serveur envoie `application/octet-stream` SANS `Content-Encoding: gzip` :
  // `fetch` ne décompresse pas, c'est à nous de le faire.
  if (archive.byteLength < MIN_ARCHIVE_BYTES) {
    throw new Error(
      `Archive anormalement petite (${archive.byteLength} o) — page d'erreur déguisée ?`
    );
  }

  return gunzipSync(archive).toString('utf8');
}

/**
 * Cache disque de l'archive, pour la mise au point.
 *
 * Retélécharger 5,9 Mo à chaque essai est inutile : la source ne se régénère
 * qu'une fois par jour. Inactif en CI, où le cache n'existe pas.
 */
const CACHE_PATH = path.join(
  process.env.AZYMUT_EPG_CACHE_DIR || 'out/.epg-cache',
  'epgshare-fr1.xml'
);
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function readCache() {
  if (process.env.AZYMUT_EPG_REFRESH === '1') return null;

  try {
    const info = await stat(CACHE_PATH);
    if (Date.now() - info.mtimeMs > CACHE_MAX_AGE_MS) return null;

    const xml = await readFile(CACHE_PATH, 'utf8');
    console.log(`  source : cache local (${(xml.length / 1024 / 1024).toFixed(1)} Mo)`);
    return xml;
  } catch {
    return null;
  }
}

async function main() {
  const outPath = process.argv[2] ?? 'docs/epg/guide.json';

  console.log('Guide TV Azymut');

  let xml = await readCache();
  if (!xml) {
    console.log(`  source : ${SOURCE_URL}`);
    xml = await download(SOURCE_URL);
    console.log(`  téléchargé et décompressé : ${(xml.length / 1024 / 1024).toFixed(1)} Mo`);

    try {
      await mkdir(path.dirname(CACHE_PATH), { recursive: true });
      await writeFile(CACHE_PATH, xml, 'utf8');
    } catch {
      // Un cache non écrit ne doit pas faire échouer la génération.
    }
  }

  const result = buildGuide(xml);
  assertUsable(result);

  const json = JSON.stringify(result.guide);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, json, 'utf8');

  const channels = Object.entries(result.guide.channels);
  const total = channels.reduce((n, [, c]) => n + c.p.length, 0);
  const withIcon = channels.reduce(
    (n, [, c]) => n + c.p.filter((p) => p.i).length,
    0
  );

  console.log(`  chaînes    : ${channels.length}`);
  console.log(`  programmes : ${total} (${Math.round((100 * withIcon) / total)} % illustrés)`);
  console.log(`  écrit      : ${outPath} — ${(json.length / 1024 / 1024).toFixed(2)} Mo`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  });
}
