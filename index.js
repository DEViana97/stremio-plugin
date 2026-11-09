'use strict';

const express = require('express');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Configuração ──────────────────────────────────────────────────────────── */
const SAIMO_CANAIS = 'https://canais-saimo.pages.dev/';
const SAIMO_FILMES = 'https://filmes-saimo.pages.dev/';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

/* ── Cache em memória ──────────────────────────────────────────────────────── */
let cacheCanais = null; let cacheCanaisAt = 0;
let cacheBusca  = null; let cacheBuscaAt  = 0;
let cacheBases  = null; let cacheBasesAt  = 0;

/* ── Helpers ───────────────────────────────────────────────────────────────── */
function slug(s) {
  return s.toLowerCase()
    .replace(/[áàâãä]/g, 'a').replace(/[éêèë]/g, 'e')
    .replace(/[íìîï]/g, 'i').replace(/[óôõòö]/g, 'o')
    .replace(/[úùûü]/g, 'u').replace(/ç/g, 'c').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function idCanal(nome)  { return 'saimo_tv_'  + slug(nome); }
function idFilme(titulo){ return 'saimo_mv_'  + slug(titulo); }
function idSerie(titulo){ return 'saimo_ser_' + slug(titulo); }

function letraIdx(titulo) {
  const c = titulo.trim()[0]?.toLowerCase();
  if (!c || c < 'a' || c > 'z') return '0';
  return c;
}

/* ── Fetch com cache simples ───────────────────────────────────────────────── */
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/* ── Parser do catalogo.txt ─────────────────────────────────────────────────
   canal: Nome · logo: url · categoria: cat · fonte: url · referer: · agente: · chave: (descarta)
   ─────────────────────────────────────────────────────────────────────────── */
function parseCatalogo(txt) {
  const canais = [];
  for (const linha of txt.split('\n')) {
    const l = linha.trim();
    if (!l || l.startsWith('#')) continue;
    const sep = l.indexOf(':');
    if (sep < 0) continue;
    const campo = l.slice(0, sep).trim().toLowerCase();
    const valor = l.slice(sep + 1).trim();
    if (!valor) continue;
    switch (campo) {
      case 'canal':    canais.push({ nome: valor, logo: '', categoria: '', fontes: [] }); break;
      case 'logo':     if (canais.length) canais.at(-1).logo = valor; break;
      case 'categoria':if (canais.length) canais.at(-1).categoria = valor; break;
      case 'fonte':    if (canais.length) canais.at(-1).fontes.push({ url: valor, referer: '', agente: '' }); break;
      case 'referer':  if (canais.length && canais.at(-1).fontes.length) canais.at(-1).fontes.at(-1).referer = valor; break;
      case 'agente':   if (canais.length && canais.at(-1).fontes.length) canais.at(-1).fontes.at(-1).agente = valor; break;
      case 'chave':    if (canais.length && canais.at(-1).fontes.length) canais.at(-1).fontes.pop(); break; // ClearKey — descarta
    }
  }
  return canais.filter(c => c.fontes.length > 0);
}

/* ── Parser do busca.txt ─────────────────────────────────────────────────────
   titulo\t(s|f)\tletra\tano
   ─────────────────────────────────────────────────────────────────────────── */
function parseBusca(txt) {
  const itens = [];
  for (const linha of txt.split('\n')) {
    const p = linha.split('\t');
    if (p.length < 3) continue;
    const [titulo, tipo, letra, ano] = p.map(x => x.trim());
    if (!titulo || !tipo || !letra) continue;
    itens.push({ titulo, tipo, letra, ano: ano || '' });
  }
  return itens;
}

/* ── Parser do indice.txt ────────────────────────────────────────────────────
   base: https://cdn.example.com/
   ─────────────────────────────────────────────────────────────────────────── */
function parseBases(txt) {
  const bases = [];
  for (const linha of txt.split('\n')) {
    const l = linha.trim();
    if (l.startsWith('base:')) bases.push(l.slice(5).trim());
  }
  return bases;
}

function montarUrl(valor, bases) {
  if (!valor) return null;
  if (valor.startsWith('http')) return valor;
  // valor relativo: "arquivo.mp4" ou "pasta/arquivo.mp4"
  for (const base of bases) {
    return base.endsWith('/') ? base + valor : base + '/' + valor;
  }
  return null;
}

/* ── Fetchers com cache ────────────────────────────────────────────────────── */
async function buscarCatalogo() {
  if (cacheCanais && Date.now() - cacheCanaisAt < CACHE_TTL_MS) return cacheCanais;
  cacheCanais = parseCatalogo(await fetchText(SAIMO_CANAIS + 'catalogo.txt'));
  cacheCanaisAt = Date.now();
  console.log(`[saimo] canais: ${cacheCanais.length}`);
  return cacheCanais;
}

async function buscarBusca() {
  if (cacheBusca && Date.now() - cacheBuscaAt < CACHE_TTL_MS) return cacheBusca;
  cacheBusca = parseBusca(await fetchText(SAIMO_FILMES + 'busca.txt'));
  cacheBuscaAt = Date.now();
  console.log(`[saimo] busca: ${cacheBusca.length} itens`);
  return cacheBusca;
}

async function buscarBases() {
  if (cacheBases && Date.now() - cacheBasesAt < CACHE_TTL_MS) return cacheBases;
  cacheBases = parseBases(await fetchText(SAIMO_FILMES + 'indice.txt'));
  cacheBasesAt = Date.now();
  return cacheBases;
}

/* ── Parser de filmes-X.txt ──────────────────────────────────────────────────
   titulo\tversao=url1,url2,...
   ─────────────────────────────────────────────────────────────────────────── */
async function buscarUrlsFilme(titulo, letra) {
  const txt   = await fetchText(SAIMO_FILMES + 'filmes-' + letra + '.txt');
  const bases = await buscarBases();
  const urls  = [];
  for (const linha of txt.split('\n')) {
    const tab = linha.indexOf('\t');
    if (tab < 0) continue;
    const t = linha.slice(0, tab).trim();
    if (t.toLowerCase() !== titulo.toLowerCase()) continue;
    const resto = linha.slice(tab + 1).trim();
    const eqIdx = resto.indexOf('=');
    if (eqIdx < 0) continue;
    const versao = resto.slice(0, eqIdx).trim();
    const partes = resto.slice(eqIdx + 1).split(',');
    for (const p of partes) {
      const u = montarUrl(p.trim(), bases);
      if (u) urls.push({ versao, url: u });
    }
  }
  return urls;
}

/* ── Parser de series-X.txt ──────────────────────────────────────────────────
   titulo\tano\tpedaco\tepisodios
   ─────────────────────────────────────────────────────────────────────────── */
async function buscarMetaSerie(titulo, letra) {
  const txt = await fetchText(SAIMO_FILMES + 'series-' + letra + '.txt');
  for (const linha of txt.split('\n')) {
    const p = linha.split('\t');
    if (p.length < 3) continue;
    if (p[0].trim().toLowerCase() !== titulo.toLowerCase()) continue;
    return { ano: (p[1] || '').trim(), pedaco: parseInt(p[2]) || 1 };
  }
  return null;
}

/* ── Parser de series-X-N.txt ────────────────────────────────────────────────
   @titulo\tano  (header)
   temporada\tnumero\tversao\turls
   ─────────────────────────────────────────────────────────────────────────── */
async function buscarEpisodios(titulo, letra, pedaco) {
  const txt   = await fetchText(SAIMO_FILMES + 'series-' + letra + '-' + pedaco + '.txt');
  const bases = await buscarBases();
  let dentro  = false;
  const eps   = [];

  for (const linha of txt.split('\n')) {
    const l = linha.trim();
    if (!l) continue;
    if (l.startsWith('@')) {
      const t = l.slice(1).split('\t')[0].trim();
      dentro = t.toLowerCase() === titulo.toLowerCase();
      continue;
    }
    if (!dentro) continue;
    if (l.startsWith('@')) { dentro = false; continue; }
    const p = l.split('\t');
    if (p.length < 4) continue;
    const [temp, num, versao, urlsRaw] = p.map(x => x.trim());
    const urls = urlsRaw.split(',').map(u => montarUrl(u.trim(), bases)).filter(Boolean);
    if (urls.length) eps.push({ temp: parseInt(temp) || 1, num: parseInt(num) || 1, versao, urls });
  }
  return eps;
}

/* ── CORS ───────────────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

/* ── Manifest ───────────────────────────────────────────────────────────────── */
const MANIFEST = {
  id:          'com.saimotv.stremio',
  version:     '2.0.0',
  name:        'Saimo TV',
  description: 'Canais ao vivo, filmes e séries do Saimo TV.',
  logo:        'https://canais-saimo.pages.dev/favicon.ico',
  resources:   ['catalog', 'stream', 'meta'],
  types:       ['tv', 'movie', 'series'],
  catalogs: [
    {
      type: 'tv',
      id:   'saimo-ao-vivo',
      name: 'Saimo TV — Ao Vivo',
      extra: [{ name: 'genre', isRequired: false }]
    },
    {
      type:  'movie',
      id:    'saimo-filmes',
      name:  'Saimo TV — Filmes',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false }
      ]
    },
    {
      type:  'series',
      id:    'saimo-series',
      name:  'Saimo TV — Séries',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false }
      ]
    }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

/* ── Catalog: canais ao vivo ─────────────────────────────────────────────────── */
app.get('/catalog/tv/saimo-ao-vivo.json', async (req, res) => {
  try {
    const canais   = await buscarCatalogo();
    const genero   = req.query.genre || '';
    const filtrados = genero
      ? canais.filter(c => c.categoria.toLowerCase() === genero.toLowerCase())
      : canais;
    const generos  = [...new Set(canais.map(c => c.categoria).filter(Boolean))];
    const metas    = filtrados.map(c => ({
      id:          idCanal(c.nome),
      type:        'tv',
      name:        c.nome,
      poster:      c.logo || undefined,
      logo:        c.logo || undefined,
      genres:      c.categoria ? [c.categoria] : [],
      description: c.categoria || 'Canal ao vivo'
    }));
    res.json({ metas, genres: generos });
  } catch (err) {
    console.error('[catalog/tv]', err.message);
    res.status(500).json({ metas: [] });
  }
});

/* ── Catalog helper: busca VOD ─────────────────────────────────────────────── */
async function catalogVod(tipo, query, skip) {
  const todos = (await buscarBusca()).filter(i => i.tipo === tipo);
  let lista   = todos;
  if (query) {
    const q = query.toLowerCase();
    lista = todos.filter(i => i.titulo.toLowerCase().includes(q));
  }
  const PAGE = 100;
  const from = parseInt(skip) || 0;
  const page = lista.slice(from, from + PAGE);
  return page.map(i => ({
    id:    tipo === 'f' ? idFilme(i.titulo) : idSerie(i.titulo),
    type:  tipo === 'f' ? 'movie' : 'series',
    name:  i.titulo,
    year:  i.ano || undefined,
    description: i.ano ? `(${i.ano})` : undefined
  }));
}

/* ── Catalog: filmes ──────────────────────────────────────────────────────── */
app.get('/catalog/movie/saimo-filmes.json', async (req, res) => {
  try {
    const metas = await catalogVod('f', req.query.search, req.query.skip);
    res.json({ metas });
  } catch (err) {
    console.error('[catalog/movie]', err.message);
    res.status(500).json({ metas: [] });
  }
});

/* ── Catalog: séries ─────────────────────────────────────────────────────── */
app.get('/catalog/series/saimo-series.json', async (req, res) => {
  try {
    const metas = await catalogVod('s', req.query.search, req.query.skip);
    res.json({ metas });
  } catch (err) {
    console.error('[catalog/series]', err.message);
    res.status(500).json({ metas: [] });
  }
});

/* ── Meta: filme ─────────────────────────────────────────────────────────── */
app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    const id    = req.params.id;
    const busca = await buscarBusca();
    const item  = busca.find(i => i.tipo === 'f' && idFilme(i.titulo) === id);
    if (!item) return res.json({ meta: {} });
    res.json({ meta: {
      id,
      type:  'movie',
      name:  item.titulo,
      year:  item.ano || undefined,
      description: item.ano ? `Filme · ${item.ano}` : 'Filme'
    }});
  } catch (err) {
    console.error('[meta/movie]', err.message);
    res.status(500).json({ meta: {} });
  }
});

/* ── Meta: série ─────────────────────────────────────────────────────────── */
app.get('/meta/series/:id.json', async (req, res) => {
  try {
    const id    = req.params.id;
    const busca = await buscarBusca();
    const item  = busca.find(i => i.tipo === 's' && idSerie(i.titulo) === id);
    if (!item) return res.json({ meta: {} });

    const meta_s = await buscarMetaSerie(item.titulo, item.letra);
    if (!meta_s) return res.json({ meta: {} });

    // Carrega todos os episódios para construir o meta completo
    const pedacos = Array.from({ length: meta_s.pedaco }, (_, k) => k + 1);
    let allEps = [];
    for (const p of pedacos) {
      try {
        const eps = await buscarEpisodios(item.titulo, item.letra, p);
        allEps = allEps.concat(eps);
      } catch (_) {}
    }

    // Monta videos[] para o Stremio (uma entrada por episódio)
    const videos = allEps.map(ep => ({
      id:       `${id}:${ep.temp}:${ep.num}`,
      title:    `T${ep.temp} E${ep.num}` + (ep.versao ? ` — ${ep.versao}` : ''),
      season:   ep.temp,
      episode:  ep.num,
      released: undefined
    }));

    res.json({ meta: {
      id,
      type:   'series',
      name:   item.titulo,
      year:   item.ano || undefined,
      videos,
      description: item.ano ? `Série · ${item.ano}` : 'Série'
    }});
  } catch (err) {
    console.error('[meta/series]', err.message);
    res.status(500).json({ meta: {} });
  }
});

/* ── Stream: canal ao vivo ───────────────────────────────────────────────── */
app.get('/stream/tv/:id.json', async (req, res) => {
  try {
    const id    = req.params.id;
    const canais = await buscarCatalogo();
    const canal  = canais.find(c => idCanal(c.nome) === id);
    if (!canal) return res.json({ streams: [] });

    const streams = canal.fontes.map((f, i) => {
      const s = {
        url:   f.url,
        name:  'Saimo TV',
        title: canal.nome + (canal.fontes.length > 1 ? ` · Fonte ${i + 1}` : ''),
        behaviorHints: { notWebReady: false }
      };
      if (f.referer || f.agente) {
        s.behaviorHints.proxyHeaders = { request: {
          ...(f.referer ? { Referer: f.referer }     : {}),
          ...(f.agente  ? { 'User-Agent': f.agente } : {})
        }};
      }
      return s;
    });
    res.json({ streams });
  } catch (err) {
    console.error('[stream/tv]', err.message);
    res.status(500).json({ streams: [] });
  }
});

/* ── Stream: filme ───────────────────────────────────────────────────────── */
app.get('/stream/movie/:id.json', async (req, res) => {
  try {
    const id    = req.params.id;
    const busca = await buscarBusca();
    const item  = busca.find(i => i.tipo === 'f' && idFilme(i.titulo) === id);
    if (!item) return res.json({ streams: [] });

    const urls = await buscarUrlsFilme(item.titulo, item.letra);
    const streams = urls.map((u, i) => ({
      url:   u.url,
      name:  'Saimo TV',
      title: u.versao || `Fonte ${i + 1}`
    }));
    res.json({ streams });
  } catch (err) {
    console.error('[stream/movie]', err.message);
    res.status(500).json({ streams: [] });
  }
});

/* ── Stream: episódio de série ───────────────────────────────────────────── */
// ID formato: saimo_ser_<slug>:<temporada>:<episodio>
app.get('/stream/series/:id.json', async (req, res) => {
  try {
    const raw   = req.params.id; // ex: saimo_ser_breaking_bad:1:3
    const parts = raw.split(':');
    if (parts.length < 3) return res.json({ streams: [] });

    const serieId = parts[0];
    const temp    = parseInt(parts[1]);
    const num     = parseInt(parts[2]);

    const busca = await buscarBusca();
    const item  = busca.find(i => i.tipo === 's' && idSerie(i.titulo) === serieId);
    if (!item) return res.json({ streams: [] });

    const meta_s = await buscarMetaSerie(item.titulo, item.letra);
    if (!meta_s) return res.json({ streams: [] });

    // Procura em todos os pedaços
    for (let p = 1; p <= meta_s.pedaco; p++) {
      let eps;
      try { eps = await buscarEpisodios(item.titulo, item.letra, p); }
      catch (_) { continue; }

      const ep = eps.find(e => e.temp === temp && e.num === num);
      if (!ep) continue;

      const streams = ep.urls.map((u, i) => ({
        url:   u,
        name:  'Saimo TV',
        title: `T${temp} E${num}` + (ep.versao ? ` — ${ep.versao}` : '') + (ep.urls.length > 1 ? ` · Fonte ${i + 1}` : '')
      }));
      return res.json({ streams });
    }
    res.json({ streams: [] });
  } catch (err) {
    console.error('[stream/series]', err.message);
    res.status(500).json({ streams: [] });
  }
});

/* ── Health check ───────────────────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'ok', addon: MANIFEST.name, version: MANIFEST.version });
});

/* ── Inicia ─────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`[saimo-stremio] rodando em http://localhost:${PORT}`);
  buscarCatalogo().catch(console.error);
  buscarBusca().catch(console.error);
});
