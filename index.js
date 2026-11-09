'use strict';

const express = require('express');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Configuração ──────────────────────────────────────────────────────────── */
const SAIMO_CANAIS = 'https://canais-saimo.pages.dev/';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

/* ── Cache em memória ──────────────────────────────────────────────────────── */
let cacheCanais = null;
let cacheAt     = 0;

async function buscarCatalogo() {
  if (cacheCanais && Date.now() - cacheAt < CACHE_TTL_MS) return cacheCanais;
  const res  = await fetch(SAIMO_CANAIS + 'catalogo.txt');
  const text = await res.text();
  cacheCanais = parseCatalogo(text);
  cacheAt     = Date.now();
  console.log(`[saimo] catálogo atualizado: ${cacheCanais.length} canais`);
  return cacheCanais;
}

/* ── Parser do catalogo.txt ─────────────────────────────────────────────────
   Formato:
     canal: Nome do Canal
     logo: https://...
     categoria: TV Aberta
     fonte: https://stream.m3u8
     referer: https://...   (opcional)
     agente: Mozilla/5.0    (opcional)
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
      case 'canal':
        canais.push({ nome: valor, logo: '', categoria: '', fontes: [] });
        break;
      case 'logo':
        if (canais.length) canais.at(-1).logo = valor;
        break;
      case 'categoria':
        if (canais.length) canais.at(-1).categoria = valor;
        break;
      case 'fonte':
        if (canais.length) canais.at(-1).fontes.push({ url: valor, referer: '', agente: '' });
        break;
      case 'referer':
        if (canais.length && canais.at(-1).fontes.length)
          canais.at(-1).fontes.at(-1).referer = valor;
        break;
      case 'agente':
        if (canais.length && canais.at(-1).fontes.length)
          canais.at(-1).fontes.at(-1).agente = valor;
        break;
      case 'chave':
        // ClearKey — descarta a fonte (não suportado)
        if (canais.length && canais.at(-1).fontes.length)
          canais.at(-1).fontes.pop();
        break;
    }
  }
  return canais.filter(c => c.fontes.length > 0);
}

/* Gera um ID estável a partir do nome do canal */
function idCanal(nome) {
  return 'saimo_' + nome.toLowerCase()
    .replace(/[áàâãä]/g, 'a').replace(/[éêè]/g, 'e')
    .replace(/[íìî]/g, 'i').replace(/[óôõò]/g, 'o')
    .replace(/[úùû]/g, 'u').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
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
  version:     '1.0.0',
  name:        'Saimo TV',
  description: 'Canais ao vivo do Saimo TV — TV Aberta, Esportes, Notícias e mais.',
  logo:        'https://canais-saimo.pages.dev/favicon.ico',
  resources:   ['catalog', 'stream'],
  types:       ['tv'],
  catalogs: [
    {
      type: 'tv',
      id:   'saimo-ao-vivo',
      name: 'Saimo TV — Ao Vivo',
      extra: [{ name: 'genre', isRequired: false }]
    }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

/* ── Catalog ────────────────────────────────────────────────────────────────── */
app.get('/catalog/tv/saimo-ao-vivo.json', async (req, res) => {
  try {
    const canais = await buscarCatalogo();
    const genero = req.query.genre || '';

    const filtrados = genero
      ? canais.filter(c => c.categoria.toLowerCase() === genero.toLowerCase())
      : canais;

    // Gêneros únicos para filtro lateral no Stremio
    const generos = [...new Set(canais.map(c => c.categoria).filter(Boolean))];

    const metas = filtrados.map(c => ({
      id:          idCanal(c.nome),
      type:        'tv',
      name:        c.nome,
      poster:      c.logo || undefined,
      logo:        c.logo || undefined,
      genres:      c.categoria ? [c.categoria] : [],
      background:  undefined,
      description: c.categoria || 'Canal ao vivo'
    }));

    res.json({ metas, genres: generos });
  } catch (err) {
    console.error('[catalog]', err.message);
    res.status(500).json({ metas: [] });
  }
});

/* ── Stream ─────────────────────────────────────────────────────────────────── */
app.get('/stream/tv/:id.json', async (req, res) => {
  try {
    const id     = req.params.id;
    const canais = await buscarCatalogo();
    const canal  = canais.find(c => idCanal(c.nome) === id);

    if (!canal) return res.json({ streams: [] });

    const streams = canal.fontes.map((f, i) => {
      const s = {
        url:   f.url,
        name:  `Saimo TV`,
        title: canal.nome + (canal.fontes.length > 1 ? ` · Fonte ${i + 1}` : ''),
        behaviorHints: { notWebReady: false }
      };
      // Adiciona headers se necessário (referer/user-agent)
      if (f.referer || f.agente) {
        s.behaviorHints.proxyHeaders = {
          request: {
            ...(f.referer ? { Referer: f.referer }         : {}),
            ...(f.agente  ? { 'User-Agent': f.agente }     : {})
          }
        };
      }
      return s;
    });

    res.json({ streams });
  } catch (err) {
    console.error('[stream]', err.message);
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
  // Pré-aquece o cache ao iniciar
  buscarCatalogo().catch(console.error);
});
