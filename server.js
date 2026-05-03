const express = require('express')
const puppeteer = require('puppeteer-core')
const http = require('http')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '10mb' }))

const API_KEY = process.env.SCRAPER_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

async function requireAuth(req, res, next) {
  // Admin key — permite accesul la rutele admin fara JWT
  const adminKey = req.headers['x-admin-key']
  if (process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY) return next()

  // Metoda 1 (legacy): API key static
  const apiKey = req.headers['x-api-key']
  if (API_KEY && apiKey === API_KEY) return next()

  // Metoda 2 (noua): Supabase JWT
  const authHeader = req.headers['authorization']
  if (authHeader?.startsWith('Bearer ') && supabase) {
    const token = authHeader.slice(7)
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (!error && user) {
      req.user = user
      return next()
    }
  }

  return res.status(401).json({ error: 'Unauthorized' })
}

// Rate limiting: max 60 req/minut per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many requests, please try again later.' },
})

app.use(limiter)
app.use(requireAuth)

// Formatul roman: 1-6 cifre / 1-4 cifre / 4 cifre (ex: 1234/299/2023)
const DOSAR_REGEX = /^\d{1,6}\/\d{1,4}\/\d{4}$/

function sanitizeNumarDosar(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!DOSAR_REGEX.test(trimmed)) return null
  return trimmed
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const PORTAL_URL = 'https://portal.just.ro/SitePages/dosare.aspx'

const SEL_INPUT   = '#ctl00_PlaceHolderMain_g_3c48c3b5_52ec_496d_ac28_a489959dea03_SPTextSlicerValueTextControl'
const SEL_BTN     = '#ctl00_PlaceHolderMain_g_59efd732_290a_4da4_9c75_96bbb4876db7_Image'
const SEL_RESULTS = '#ctl00_PlaceHolderMain_g_68d0a18f_4090_4010_a8f6_ffb51775d6aa'

async function scrapeDosar(numarDosar) {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
    ],
    headless: true,
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1280, height: 800 })

    console.log(`[scraper] Navighez la portal pentru: ${numarDosar}`)
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 })

    await page.waitForSelector(SEL_INPUT, { timeout: 10000 })
    await page.click(SEL_INPUT, { clickCount: 3 })
    await page.type(SEL_INPUT, numarDosar, { delay: 50 })

    await page.waitForSelector(SEL_BTN, { timeout: 5000 })
    await Promise.all([
      page.click(SEL_BTN),
      page.waitForResponse(r => r.url().includes('dosare.aspx'), { timeout: 15000 }),
    ])

    await new Promise(r => setTimeout(r, 3000))

    // Extrage rezultatele din grila
    const pageData = await page.evaluate((selResults) => {
      const bodyText = document.body?.innerText ?? ''
      const rezultate = []
      const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean)

      for (const line of lines) {
        const parts = line.split('\t').map(p => p.trim()).filter(Boolean)
        if (parts.length >= 4) {
          const nrMatch = parts.find(p => /^\d{1,6}\/\d{2,4}\/\d{4}$/.test(p))
          if (nrMatch) {
            const idx = parts.indexOf(nrMatch)
            rezultate.push({
              numar_dosar: nrMatch,
              instanta: idx > 0 ? parts[idx - 1] : null,
              data_dosar: idx + 1 < parts.length ? parts[idx + 1] : null,
              obiect: idx + 2 < parts.length ? parts[idx + 2] : null,
              materie: idx + 3 < parts.length ? parts[idx + 3] : null,
              stadiu: idx + 4 < parts.length ? parts[idx + 4] : null,
            })
          }
        }
      }

      const termene = [...bodyText.matchAll(/(\d{2}[.]\d{2}[.]\d{4})/g)]
        .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5)

      // Numara link-urile din container pentru debug
      const container = document.querySelector(selResults)
      const linkCount = container ? container.querySelectorAll('a').length : 0

      return { rezultate, termene, linkCount }
    }, SEL_RESULTS)

    console.log(`[scraper] rezultate=${pageData.rezultate.length}, linkuri=${pageData.linkCount}`)

    // Incearca sa extraga partile din pagina de detaliu
    let parti = []
    if (pageData.rezultate.length > 0) {
      parti = await scrapeParti(page, numarDosar, SEL_RESULTS)
    }

    const rezultate = pageData.rezultate.map(r => ({
      ...r,
      parti,
      termene_urmatoare: pageData.termene,
    }))

    return { rezultate }
  } finally {
    await browser.close()
  }
}

async function scrapeParti(page, numarDosar, selResults) {
  try {
    console.log('[scraper] Caut element dosar in pagina...')

    // Log structura paginii pentru debug
    const debug = await page.evaluate((numar) => {
      const all = Array.from(document.querySelectorAll('a, tr, td, [onclick]'))
      const withDosar = all.filter(el => el.textContent?.includes(numar)).slice(0, 5)
      return {
        totalElements: all.length,
        withDosar: withDosar.map(el => ({
          tag: el.tagName,
          onclick: el.getAttribute('onclick')?.slice(0, 80) ?? null,
          text: el.textContent?.trim().slice(0, 60),
          id: el.id || null,
        })),
        allLinks: Array.from(document.querySelectorAll('a')).length,
      }
    }, numarDosar)
    console.log('[scraper] Debug pagina:', JSON.stringify(debug))

    // Incearca sa dea click pe elementul care contine numarul dosarului
    const clicked = await page.evaluate((numar) => {
      // Cauta orice element care contine exact numarul dosarului
      const candidates = Array.from(document.querySelectorAll('a, td, tr, span, div'))
        .filter(el => el.textContent?.trim().includes(numar))

      if (candidates.length === 0) return 'no-element'

      // Prefera link-uri sau elemente cu onclick
      let target = candidates.find(el => el.tagName === 'A' || el.getAttribute('onclick'))
      if (!target) {
        // Ia primul TD care contine numarul si incearca sa-i gaseasca parintele TR
        const td = candidates.find(el => el.tagName === 'TD')
        if (td) {
          const tr = td.closest('tr')
          const link = tr?.querySelector('a')
          if (link) { link.click(); return 'tr-link' }
          if (tr) { tr.click(); return 'tr-click' }
          td.click(); return 'td-click'
        }
        // Fallback: primul element gasit
        target = candidates[0]
      }

      target.click()
      return `click-${target.tagName}`
    }, numarDosar)

    console.log(`[scraper] Click rezultat: ${clicked}`)
    if (clicked === 'no-element') return []

    // Asteapta navigarea — poate fi lenta pe SharePoint
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 })
    } catch (_) {
      // Daca nu e navigare, e posibil expand in pagina — asteptam oricum
    }
    await new Promise(r => setTimeout(r, 3000))

    // Log URL curent + textul paginii de detaliu
    const currentUrl = page.url()
    console.log('[scraper] URL dupa click:', currentUrl)
    let pageText = ''
    try {
      pageText = await page.evaluate(() => document.body?.innerText ?? '')
      console.log('[scraper] Pagina detaliu (primele 1000 chars):', pageText.slice(0, 1000).replace(/\n+/g, ' | '))
    } catch (e) {
      console.log('[scraper] Eroare evaluate dupa click:', e.message)
      return []
    }

    // Extrage partile din pagina de detaliu
    const parti = await page.evaluate(() => {
      const text = document.body?.innerText ?? ''
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

      const result = []

      // Detecteaza header-ul tabelului de parti: "Nume    Calitate parte"
      // Acesta apare o singura data, dupa sectiunea de navigare
      let headerIdx = -1
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase()
        if (l.includes('calitate parte') || l.includes('calitate\tparte') || (l.includes('nume') && l.includes('calitate'))) {
          headerIdx = i
          break
        }
      }

      if (headerIdx === -1) return []

      // Extrage randurile dupa header pana la urmatoarea sectiune
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i]
        const lower = line.toLowerCase()

        // Opreste la urmatoarea sectiune (Sedinte, Cai atac, etc.)
        if (
          lower.includes('şedin') || lower.includes('sedin') ||
          lower.includes('căi atac') || lower.includes('cai atac') ||
          lower.includes('citare') || lower.includes('nu exist')
        ) break

        // Extrage numele — "Călin Costel    Petent" → "Călin Costel"
        const name = line.split(/\s{2,}|\t/)[0].trim()
        if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !result.includes(name)) {
          result.push(name)
        }
      }

      return result
    })

    console.log(`[scraper] Parti gasite: ${parti.length} — ${parti.join(', ')}`)
    return parti
  } catch (e) {
    console.log('[scraper] Parti eroare:', e.message)
    return []
  }
}

async function scrapeTermeneOnPage(page, numarDosar) {
  console.log(`[batch] Caut termene pentru: ${numarDosar}`)

  await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForSelector(SEL_INPUT, { timeout: 10000 })
  await page.click(SEL_INPUT, { clickCount: 3 })
  await page.type(SEL_INPUT, numarDosar, { delay: 40 })

  await page.waitForSelector(SEL_BTN, { timeout: 5000 })
  await Promise.all([
    page.click(SEL_BTN),
    page.waitForResponse(r => r.url().includes('dosare.aspx'), { timeout: 15000 }),
  ])
  await new Promise(r => setTimeout(r, 2500))

  const termene = await page.evaluate(() => {
    const text = document.body?.innerText ?? ''
    return [...text.matchAll(/(\d{2}[.]\d{2}[.]\d{4})/g)]
      .map(m => m[1])
      .filter((v, i, a) => a.indexOf(v) === i)
  })

  console.log(`[batch] ${numarDosar} → ${termene.length} date: ${termene.join(', ')}`)
  return termene
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.post('/cauta-dosar', async (req, res) => {
  const numar_dosar = sanitizeNumarDosar(req.body?.numar_dosar)
  if (!numar_dosar) {
    return res.json({ rezultate: [], error: 'Numar dosar invalid. Format asteptat: NNNNN/NNN/YYYY' })
  }

  try {
    const result = await scrapeDosar(numar_dosar)
    res.json(result)
  } catch (err) {
    console.error('[scraper] Eroare:', err.message)
    res.json({ rezultate: [], error: err.message })
  }
})


// ─── SOAP helpers ─────────────────────────────────────────────────────────────

function soapRequest(numarDosar) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CautareDosare xmlns="portalquery.just.ro">
      <numarDosar>${escapeXml(numarDosar)}</numarDosar>
      <obiectDosar></obiectDosar>
      <numeParte></numeParte>
      <institutie xsi:nil="true" />
    </CautareDosare>
  </soap:Body>
</soap:Envelope>`
}

function httpPost(body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf-8')
    const req = http.request({
      hostname: 'portalquery.just.ro',
      path: '/query.asmx',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"portalquery.just.ro/CautareDosare"',
        'Content-Length': bodyBuf.length,
      },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(bodyBuf)
    req.end()
  })
}

function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
  const results = []
  let m
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim())
  return results
}

function extractOne(xml, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
  return m ? m[1].trim() : null
}

async function soapGetDosar(numarDosar) {
  const xml = await httpPost(soapRequest(numarDosar))

  const sedinteBlocks = extractAll(xml, 'DosarSedinta')
  const sedinte = sedinteBlocks.map(b => ({
    data: extractOne(b, 'data'),
    ora: extractOne(b, 'ora'),
    complet: extractOne(b, 'complet'),
    solutie: extractOne(b, 'solutie'),
    documentSedinta: extractOne(b, 'documentSedinta'),
  })).filter(s => s.data)

  const partiBlocks = extractAll(xml, 'DosarParte')
  const parti = partiBlocks.map(b => ({
    nume: extractOne(b, 'nume'),
    calitate: extractOne(b, 'calitateParte'),
  })).filter(p => p.nume)

  return { sedinte, parti }
}

app.post('/sync-soap', async (req, res) => {
  const dosare = req.body?.dosare
  if (!Array.isArray(dosare) || dosare.length === 0) return res.json({ rezultate: [] })

  console.log(`[soap] Sync pentru ${dosare.length} dosare`)

  const rezultate = await Promise.all(
    dosare.map(async numar => {
      const numarCurat = sanitizeNumarDosar(numar)
      if (!numarCurat) {
        console.log(`[soap] Numar invalid ignorat: ${numar}`)
        return { numar_dosar: numar, sedinte: [], parti: [], error: 'Format invalid' }
      }
      try {
        const { sedinte, parti } = await soapGetDosar(numarCurat)
        console.log(`[soap] ${numarCurat} → ${sedinte.length} sedinte, ${parti.length} parti`)
        return { numar_dosar: numarCurat, sedinte, parti }
      } catch (e) {
        console.log(`[soap] Eroare ${numarCurat}: ${e.message}`)
        return { numar_dosar: numarCurat, sedinte: [], parti: [] }
      }
    })
  )

  res.json({ rezultate })
})

app.post('/sync-batch', async (req, res) => {
  const dosare = req.body?.dosare
  if (!Array.isArray(dosare) || dosare.length === 0) {
    return res.json({ rezultate: [] })
  }

  console.log(`[batch] Start sync pentru ${dosare.length} dosare`)

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
    ],
    headless: true,
  })

  const rezultate = []

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1280, height: 800 })

    for (const numar of dosare) {
      try {
        const termene = await scrapeTermeneOnPage(page, numar.trim())
        rezultate.push({ numar_dosar: numar, termene_urmatoare: termene })
      } catch (e) {
        console.log(`[batch] Eroare la ${numar}: ${e.message}`)
        rezultate.push({ numar_dosar: numar, termene_urmatoare: [] })
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`[batch] Gata. ${rezultate.length} dosare procesate.`)
  res.json({ rezultate })
})

// ─── Claude Vision — Extrage tabel din fotografie ────────────────────────────

app.post('/extract-from-image', async (req, res) => {
  const { image, mimeType } = req.body
  if (!image) return res.status(400).json({ rows: [], columns: [], error: 'No image provided' })

  if (!process.env.GROK_API_KEY) {
    return res.status(503).json({ rows: [], columns: [], error: 'GROK_API_KEY not configured' })
  }

  try {
    const grokResp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${image}` },
            },
            {
              type: 'text',
              text: `Aceasta imagine contine un tabel cu dosare juridice. Extrage toate randurile vizibile din tabel ca JSON array. Returneaza DOAR JSON pur, fara niciun alt text sau explicatii. Format exact: [{"coloana1": "valoare1", "coloana2": "valoare2"}, ...]. Foloseste exact numele coloanelor din antetul tabelului ca keys. Daca nu gasesti un tabel cu date, returneaza [].`,
            },
          ],
        }],
      }),
    })

    if (!grokResp.ok) {
      const err = await grokResp.text()
      console.log('[vision] Grok eroare HTTP:', grokResp.status, err.slice(0, 200))
      return res.status(502).json({ rows: [], columns: [], error: 'Grok API error: ' + grokResp.status })
    }

    const grokData = await grokResp.json()
    const text = grokData.choices?.[0]?.message?.content?.trim() ?? ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)

    if (!jsonMatch) {
      console.log('[vision] Nu s-a gasit JSON in raspuns:', text.slice(0, 200))
      return res.json({ rows: [], columns: [] })
    }

    const rows = JSON.parse(jsonMatch[0])
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []

    console.log(`[vision] Extras ${rows.length} randuri, ${columns.length} coloane`)
    res.json({ rows, columns })
  } catch (e) {
    console.log('[vision] Eroare:', e.message)
    res.status(500).json({ rows: [], columns: [], error: e.message })
  }
})

// ─── Search firma (autocomplete) ─────────────────────────────────────────────

app.get('/search-firma', async (req, res) => {
  const q = (req.query.q || '').toString().trim()
  if (q.length < 3) return res.json({ rezultate: [] })

  try {
    const xml = await httpPost(soapRequestNumeParte(q))
    const partiBlocks = extractAll(xml, 'DosarParte')
    const vazute = new Set()
    const rezultate = []
    const qUpper = q.toUpperCase()

    function normalizeaza(n) {
      return n.toUpperCase()
        .replace(/[.\-,]/g, '')
        .replace(/\b(SC|RA|SRL|SA|SNC|SCS|SNP|SN|SA|RI|SCA)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    // Construim map: cheie normalizata → { denumire, instante, nrDosare }
    const dosareBlocks = extractAll(xml, 'Dosar')
    const firmeMap = new Map()

    for (const dosar of dosareBlocks) {
      const institutie = extractOne(dosar, 'institutie') || ''
      const partiDosar = extractAll(dosar, 'DosarParte')
      for (const b of partiDosar) {
        const nume = extractOne(b, 'nume')
        if (!nume || !nume.toUpperCase().includes(qUpper)) continue
        const cheie = normalizeaza(nume)
        if (!firmeMap.has(cheie)) {
          firmeMap.set(cheie, { denumire: nume, instante: new Set(), nrDosare: 0 })
        }
        const entry = firmeMap.get(cheie)
        entry.nrDosare++
        if (institutie) entry.instante.add(institutie.replace(/([a-z])([A-Z])/g, '$1 $2'))
      }
    }

    for (const [, entry] of firmeMap) {
      rezultate.push({
        denumire: entry.denumire,
        cui: null,
        judet: null,
        localitate: [...entry.instante].slice(0, 2).join(', ') || null,
        nr_dosare: entry.nrDosare,
      })
      if (rezultate.length >= 6) break
    }

    rezultate.sort((a, b) => (b.nr_dosare || 0) - (a.nr_dosare || 0))

    console.log(`[search-firma] "${q}" → ${rezultate.length} sugestii din portal.just.ro`)
    res.json({ rezultate })
  } catch (e) {
    console.log('[search-firma] Eroare:', e.message)
    res.json({ rezultate: [] })
  }
})

// ─── Due Diligence ───────────────────────────────────────────────────────────

function soapRequestNumeParte(numeParte) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CautareDosare xmlns="portalquery.just.ro">
      <numarDosar></numarDosar>
      <obiectDosar></obiectDosar>
      <numeParte>${escapeXml(numeParte)}</numeParte>
      <institutie xsi:nil="true" />
    </CautareDosare>
  </soap:Body>
</soap:Envelope>`
}

async function getAnafData(cui) {
  const cuiCurat = String(cui).replace(/^RO/i, '').replace(/\s/g, '').trim()
  const today = new Date().toISOString().split('T')[0]
  const body = JSON.stringify([{ cui: parseInt(cuiCurat), data: today }])
  const resp = await fetch('https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok) throw new Error(`ANAF HTTP ${resp.status}`)
  const json = await resp.json()
  const firma = json?.found?.[0]
  if (!firma) return null
  const dg = firma.date_generale || {}
  const tva = firma.inregistrare_scop_Tva || {}
  const rtvai = firma.inregistrare_RTVAI || {}
  const inactivi = firma.stare_inactiv || {}
  const splitTva = firma.inregistrare_SplitTVA || {}
  return {
    denumire: dg.denumire || null,
    cui: dg.cui || cuiCurat,
    adresa: dg.adresa || null,
    telefon: dg.telefon || null,
    cod_caen: dg.cod_CAEN || null,
    forma_juridica: dg.forma_juridica || null,
    stare: dg.stare_inregistrare || null,
    data_inregistrare: dg.data_inregistrare || null,
    nr_reg_com: dg.nrRegCom || null,
    platitor_tva: tva.scpTVA === true,
    tva_la_incasare: rtvai.statusTvaIncasare === true,
    inactiv: inactivi.statusInactivi === true,
    data_inactivare: inactivi.dataInactivare || null,
    data_reactivare: inactivi.dataReactivare || null,
    split_tva: splitTva.statusSplitTVA === true,
    e_factura: dg.statusRO_e_Factura === true,
  }
}

async function getOpenapiData(cui) {
  if (!cui) return null
  const cuiCurat = String(cui).replace(/^RO/i, '').replace(/\s/g, '').trim()
  const resp = await fetch(`https://api.openapi.ro/api/companies/${cuiCurat}`, {
    headers: { 'x-api-key': process.env.OPENAPI_RO_KEY || '' },
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok) return null
  const json = await resp.json()
  if (json?.error) return null
  return {
    nr_onrc: json?.numar_reg_com || null,
    adresa: json?.adresa || null,
    capital_social: json?.capital_social || null,
    stare: json?.stare || null,
    radiata: json?.radiata ?? false,
    ultima_declaratie: json?.ultima_declaratie || null,
    impozit_micro: json?.impozit_micro || null,
    impozit_profit: json?.impozit_profit || null,
  }
}

async function getDosarePortal(numeParte) {
  const xml = await httpPost(soapRequestNumeParte(numeParte))
  const dosareBlocks = extractAll(xml, 'Dosar')
  const qUpper = numeParte.toUpperCase()
  const acum = new Date()
  const rezultate = []

  for (const b of dosareBlocks) {
    const numar = extractOne(b, 'numar')
    if (!numar) continue

    const partiBlocks = extractAll(b, 'DosarParte')
    const parteGasita = partiBlocks.find(p => {
      const n = extractOne(p, 'nume') || ''
      return n.toUpperCase().includes(qUpper)
    })
    if (!parteGasita) continue

    const calitate = extractOne(parteGasita, 'calitateParte') || null

    const sedinteBlocks = extractAll(b, 'DosarSedinta')
    const viitoare = sedinteBlocks
      .map(s => ({ data: extractOne(s, 'data'), ora: extractOne(s, 'ora') }))
      .filter(s => s.data && new Date(s.data) >= acum)
      .sort((a, b) => new Date(a.data) - new Date(b.data))

    rezultate.push({
      numar,
      instanta: extractOne(b, 'institutie'),
      obiect: extractOne(b, 'obiect'),
      stadiu: extractOne(b, 'stadiuProcesual'),
      calitate_firma: calitate,
      urmator_termen: viitoare[0] || null,
    })

    if (rezultate.length >= 20) break
  }

  return rezultate
}

app.post('/due-diligence', async (req, res) => {
  const { cui, denumire } = req.body || {}
  if (!cui && !denumire) {
    return res.status(400).json({ error: 'Furnizeaza CUI sau denumire firma' })
  }

  console.log(`[due-diligence] Verificare: CUI=${cui} / denumire=${denumire}`)

  // Pas 1 — ANAF primul (avem nevoie de denumire pentru portal)
  let anaf = null
  let anafOk = false
  if (cui) {
    try { anaf = await getAnafData(cui); anafOk = true } catch (_) {}
  }

  // Pas 2 — portal + openapi in paralel, folosind denumirea din ANAF daca nu e furnizata
  const numePentruPortal = denumire || anaf?.denumire || ''
  console.log(`[due-diligence] Cautare portal cu: "${numePentruPortal}"`)

  const [openapiResult, dosareResult] = await Promise.allSettled([
    cui ? getOpenapiData(cui) : Promise.resolve(null),
    numePentruPortal ? getDosarePortal(numePentruPortal) : Promise.resolve([]),
  ])

  res.json({
    anaf,
    openapi: openapiResult.status === 'fulfilled' ? openapiResult.value : null,
    dosare_portal: dosareResult.status === 'fulfilled' ? dosareResult.value : [],
    surse: {
      anaf: anafOk,
      openapi: openapiResult.status === 'fulfilled' && openapiResult.value !== null,
      portal: dosareResult.status === 'fulfilled',
    },
  })
})

// ─── Stiri juridice (juridice.ro RSS) ────────────────────────────────────────

let stiriCache = { data: null, ts: 0 }
const STIRI_TTL = 6 * 60 * 60 * 1000

function decodeHtmlEntities(str) {
  return str
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&#8230;/g, '…').replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’').replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
}

function stripCdata(str) {
  return str.replace(/<!\[CDATA\[|\]\]>/g, '').trim()
}

const CATEGORII_RELEVANTE = [
  'drept civil', 'drept penal', 'drept procesual civil', 'drept procesual penal',
  'dreptul muncii', 'drept comercial', 'insolven', 'drept fiscal',
  'drept constitu', 'drept administrativ', 'dreptul familiei',
  'avocat', 'barou', 'jurispruden', 'iccj', 'ccr', 'curtea constitu',
  'executare silit', 'dreptul securit', 'legisla', 'dreptul uniunii',
  'drept imobiliar', 'dreptul propriet', 'raspundere', 'contencios',
]

function esteRelevant(categorii) {
  const joined = categorii.join(' ').toLowerCase()
  return CATEGORII_RELEVANTE.some(k => joined.includes(k))
}

async function fetchStiriJuridice() {
  const now = Date.now()
  if (stiriCache.data && now - stiriCache.ts < STIRI_TTL) return stiriCache.data

  const resp = await fetch('https://www.juridice.ro/feed', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LexioApp/1.0)' },
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) throw new Error(`juridice.ro HTTP ${resp.status}`)
  const xml = await resp.text()

  const EXCLUDE_DOMAINS = ['cariere.juridice.ro', 'citate.juridice.ro']

  const items = extractAll(xml, 'item')
    .map(item => {
      const link = (extractOne(item, 'link') || '').trim()
      if (EXCLUDE_DOMAINS.some(d => link.includes(d))) return null

      const rawTitle = stripCdata(extractOne(item, 'title') || '')
      const title = decodeHtmlEntities(rawTitle)
      const pubDate = (extractOne(item, 'pubDate') || '').trim()
      const cats = extractAll(item, 'category').map(c => stripCdata(c))

      if (!esteRelevant(cats)) return null

      return { title, link, pubDate, categorii: cats.slice(0, 2) }
    })
    .filter(Boolean)
    .slice(0, 8)

  stiriCache = { data: items, ts: now }
  return items
}

app.get('/stiri-juridice', async (req, res) => {
  try {
    const stiri = await fetchStiriJuridice()
    res.json({ stiri })
  } catch (e) {
    console.log('[stiri-juridice] Eroare:', e.message)
    res.status(502).json({ stiri: [], error: e.message })
  }
})

// ─── Modificari legislative (Monitorul Oficial) ──────────────────────────────

let modificariCache = { data: null, ts: 0 } // v3
const MODIFICARI_TTL = 60 * 60 * 1000

function normalizeText(str) {
  return (str || '').toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/ş/g, 's').replace(/ţ/g, 't')
}

function determinaTip(titlu) {
  const t = normalizeText(titlu)
  if (/^lege[a\s]/.test(t)) return 'Lege'
  if (t.includes('ordonanta de urgenta') || t.startsWith('oug ')) return 'OUG'
  if (/^ordonanta/.test(t)) return 'OG'
  if (/^hotarare/.test(t)) return 'HG'
  if (/^decizie/.test(t)) return 'Decizie'
  if (/^decret/.test(t)) return 'Decret'
  if (/^ordin/.test(t)) return 'Ordin'
  if (/^norme/.test(t) || /^regulament/.test(t) || /^instructiuni/.test(t)) return 'Ordin'
  return null
}

function esteActRelevant(titlu) {
  const t = normalizeText(titlu)
  return /^(lege[a\s]|ordonanta|hotarare|decizie|decret|ordin|norme|regulament|instructiuni|oug )/.test(t)
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function fetchModificariLegislative() {
  const now = Date.now()
  if (modificariCache.data && now - modificariCache.ts < MODIFICARI_TTL) {
    return modificariCache.data
  }

  const resp = await fetch('https://www.monitoruloficial.ro', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(20000),
  })
  if (!resp.ok) throw new Error(`monitoruloficial.ro HTTP ${resp.status}`)
  const html = await resp.text()

  // Structura reala confirmata:
  // <h4 style="..."><a href="/Monitorul-Oficial--PI--NR--AN.html" target="_blank">
  //   <i class="fas fa-file-pdf"></i> M. Of. nr. <strong>NR</strong> din <strong>DATA</strong>
  // </a></h4>
  // <p class="pemt">Emitent</p>
  // <p style="text-align:justify;">Titlu act</p>
  const acte = []
  const BASE = 'https://www.monitoruloficial.ro'

  const blockRe = /<h4[^>]*>\s*<a[^>]+href="(\/Monitorul-Oficial--PI[^"]+)"[^>]*>[\s\S]*?<strong>(\d+)<\/strong>\s*din\s*<strong>([^<]+)<\/strong>[\s\S]*?<\/a>\s*<\/h4>\s*<p[^>]*class="pemt"[^>]*>([\s\S]*?)<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/gi
  let m
  while ((m = blockRe.exec(html)) !== null) {
    const href = BASE + m[1]
    const numarMo = m[2].trim()
    const dataMo = m[3].trim()
    const emitent = stripTags(m[4]).trim()
    const titlu = stripTags(m[5]).trim()

    if (titlu && titlu.length > 5) {
      acte.push({ titlu, emitent, href, numarMo, dataMo })
    }
  }

  console.log(`[modificari-legislative] Total acte gasite: ${acte.length}`)

  const acteRelevante = acte
    .filter(a => esteActRelevant(a.titlu))
    .map(a => ({
      titlu: a.titlu,
      tip: determinaTip(a.titlu) || 'Act',
      emitent: a.emitent,
      numar_mo: a.numarMo,
      data: a.dataMo,
      link: a.href,
    }))
    .filter((a, i, arr) => arr.findIndex(b => b.titlu === a.titlu) === i)
    .slice(0, 20)

  console.log(`[modificari-legislative] Acte relevante: ${acteRelevante.length}`)

  modificariCache = { data: acteRelevante, ts: now }
  return acteRelevante
}

app.get('/modificari-legislative', async (req, res) => {
  try {
    const acte = await fetchModificariLegislative()
    res.json({ acte, last_updated: modificariCache.ts || Date.now() })
  } catch (e) {
    console.log('[modificari-legislative] Eroare:', e.message)
    res.status(502).json({ acte: [], error: e.message })
  }
})

// ─── LEGISLATIE ──────────────────────────────────────────────────────────────

const LEGI = [
  { id: 175630, act: 'Codul Civil', domeniu: 'Civil' },
  { id: 175638, act: 'Codul de Procedură Civilă', domeniu: 'Civil' },
  { id: 164673, act: 'Codul Penal', domeniu: 'Penal' },
  { id: 164674, act: 'Codul de Procedură Penală', domeniu: 'Penal' },
  { id: 1513,   act: 'Legea 31/1990', domeniu: 'Comercial' },
  { id: 10244,  act: 'Legea 26/1990', domeniu: 'Comercial' },
  { id: 158638, act: 'Legea 85/2014 (Insolvență)', domeniu: 'Insolventa' },
  { id: 46906,  act: 'Codul Muncii', domeniu: 'Muncii' },
  { id: 163612, act: 'Codul Fiscal', domeniu: 'Fiscal' },
  { id: 163607, act: 'Codul de Procedură Fiscală', domeniu: 'Fiscal' },
]

async function scrapeLege(docId, actNormativ, domeniu) {
  const existingNrs = new Set()
  if (supabase) {
    const { data: existing } = await supabase
      .from('legislatie_articole')
      .select('nr_articol')
      .eq('act_normativ', actNormativ)
    ;(existing || []).forEach(r => existingNrs.add(r.nr_articol))
    console.log(`[legislatie] ${actNormativ}: ${existingNrs.size} articole deja in DB`)
  }

  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
  }

  function fetchCuTimeout(url, ms) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    return fetch(url, { headers: fetchHeaders, signal: ctrl.signal })
      .finally(() => clearTimeout(timer))
  }

  // Pas 1: fetch TOC → extrage URL document real + toti anchorii
  const tocUrl = `https://legislatie.just.ro/Public/DetaliiDocumentAfis/${docId}`
  console.log(`[legislatie] Fetch TOC: ${actNormativ}`)
  const tocResp = await fetchCuTimeout(tocUrl, 30000)
  if (!tocResp.ok) throw new Error(`TOC HTTP ${tocResp.status}`)
  console.log(`[legislatie] TOC primit, parsez...`)
  const tocHtml = await tocResp.text()

  // Extrage ID-ul real al documentului din link-uri de tip /Public/DetaliiDocument/XXXXX
  const docIdMatch = tocHtml.match(/href="\/Public\/DetaliiDocument\/(\d+)[#"]/)
  const realDocId = docIdMatch ? docIdMatch[1] : String(docId)
  const docUrl = `https://legislatie.just.ro/Public/DetaliiDocument/${realDocId}`

  // Extrage toti anchorii articolelor (id_art...)
  const anchors = []
  const seen = new Set()
  for (const m of tocHtml.matchAll(/href="[^"]*#(id_art[^"&]+)"/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); anchors.push(m[1]) }
  }
  console.log(`[legislatie] Doc URL: ${docUrl} | ${anchors.length} anchori din TOC`)

  if (!anchors.length) {
    console.log(`[legislatie] Niciun anchor in TOC pentru ${actNormativ}, skip`)
    return []
  }

  // Pas 2: fetch documentul complet
  console.log(`[legislatie] Fetch document HTML: ${actNormativ}`)
  const docResp = await fetchCuTimeout(docUrl, 120000)
  if (!docResp.ok) throw new Error(`Doc HTTP ${docResp.status}`)
  console.log(`[legislatie] Document primit, parsez...`)
  const docHtml = await docResp.text()
  console.log(`[legislatie] HTML primit: ${Math.round(docHtml.length / 1024)} KB`)

  // Verifica daca articolele sunt in HTML (nu AJAX)
  if (!docHtml.includes(`id="${anchors[0]}"`)) {
    console.log(`[legislatie] Ancori absenti din HTML — site foloseste AJAX lazy load, skip`)
    return []
  }

  // Pas 3: extrage textul fiecarui articol din HTML
  let nouExtrase = 0
  let sarite = 0

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]
    const startIdx = docHtml.indexOf(`id="${anchor}"`)
    if (startIdx === -1) continue

    const nextIdx = i + 1 < anchors.length
      ? docHtml.indexOf(`id="${anchors[i + 1]}"`, startIdx + 1)
      : -1
    const endIdx = nextIdx !== -1 ? nextIdx : Math.min(startIdx + 8000, docHtml.length)

    const segment = docHtml.substring(startIdx, endIdx)
    const rawText = segment
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ').trim()

    if (!rawText || rawText.length < 10) continue

    const artMatch = rawText.match(/^(Art\.?\s*\d+[\^]?[a-z]?)\s*[-—.]?\s*(.{0,150?}?)\s{2,}([\s\S]*)/)
    const nrArticol = artMatch ? artMatch[1].trim() : anchor
    const titluArticol = artMatch && artMatch[2] && artMatch[2].length < 150 ? artMatch[2].trim() || null : null
    const textArticol = (artMatch ? artMatch[3] : rawText).replace(/\s+/g, ' ').trim()

    if (textArticol.length < 5) continue

    if (existingNrs.has(nrArticol)) {
      sarite++
    } else {
      if (supabase) {
        await supabase.from('legislatie_articole').insert({
          act_normativ: actNormativ,
          domeniu,
          nr_articol: nrArticol,
          titlu_articol: titluArticol,
          text_articol: textArticol.substring(0, 5000),
          mo_nr: null,
          mo_data: null,
        })
      }
      existingNrs.add(nrArticol)
      nouExtrase++
    }

    if ((i + 1) % 100 === 0) {
      console.log(`[legislatie] ${actNormativ}: ${i + 1}/${anchors.length} | noi: ${nouExtrase} | sarite: ${sarite}`)
    }
  }

  console.log(`[legislatie] Finalizat ${actNormativ}: ${nouExtrase} noi, ${sarite} sarite`)
  return []
}

// GET /legislatie/test-fetch — diagnosticare conectivitate
app.get('/legislatie/test-fetch', async (req, res) => {
  const url = 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/175630'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const start = Date.now()
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const html = await resp.text()
    const anchors = [...html.matchAll(/href="[^"]*#(id_art[^"&]+)"/g)].length
    res.json({ ok: true, status: resp.status, htmlKB: Math.round(html.length / 1024), anchors, ms: Date.now() - start })
  } catch (e) {
    clearTimeout(timer)
    res.json({ ok: false, error: e.message })
  }
})

// GET /legislatie/status
app.get('/legislatie/status', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })

  const LEGI_NAMES = [
    'Codul Civil', 'Codul de Procedura Civila', 'Codul Penal',
    'Codul de Procedura Penala', 'Legea 31/1990', 'Legea 26/1990',
    'Legea 85/2014 (Insolventa)', 'Codul Muncii', 'Codul Fiscal',
    'Codul de Procedura Fiscala',
  ]

  const stats = {}
  let total = 0
  for (const act of LEGI_NAMES) {
    const { count, error: e } = await supabase
      .from('legislatie_articole')
      .select('*', { count: 'exact', head: true })
      .eq('act_normativ', act)
    if (e || !count) continue
    const { data: sample } = await supabase
      .from('legislatie_articole')
      .select('domeniu, updated_at')
      .eq('act_normativ', act)
      .limit(1)
    stats[act] = { count, domeniu: sample?.[0]?.domeniu || '', updated_at: sample?.[0]?.updated_at || '' }
    total += count
  }

  res.json({ acte: stats, total })
})

// POST /legislatie/scrape — admin only
app.post('/legislatie/scrape', async (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })

  const { doc_id, act_normativ, domeniu } = req.body

  if (doc_id && act_normativ && domeniu) {
    res.json({ message: `Scraping pornit pentru ${act_normativ}` })

    scrapeLege(doc_id, act_normativ, domeniu).then(async (articole) => {
      if (!articole.length) return console.log(`[legislatie] Niciun articol: ${act_normativ}`)
      await supabase.from('legislatie_articole').delete().eq('act_normativ', act_normativ)
      for (let i = 0; i < articole.length; i += 500) {
        await supabase.from('legislatie_articole').insert(articole.slice(i, i + 500))
      }
      console.log(`[legislatie] ✓ Salvat ${articole.length} articole: ${act_normativ}`)
    }).catch(e => console.log(`[legislatie] ✗ Eroare ${act_normativ}:`, e.message))
    return
  }

  // Scrape toate legile
  res.json({ message: 'Scraping toate legile pornit' })
  scrapeToate()
})

// POST /legislatie/cauta
app.post('/legislatie/cauta', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })

  const { query, domeniu } = req.body
  if (!query?.trim()) return res.status(400).json({ error: 'Query required' })

  try {
    let termeni = [query.trim()]

    if (process.env.GROK_API_KEY) {
      try {
        const grokResp = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'grok-3-mini',
            messages: [
              {
                role: 'system',
                content: 'Ești asistent juridic specializat în drept românesc. La o interogare, returnezi DOAR un JSON array cu 3-5 termeni juridici cheie în română pentru căutare în legislație. Fără explicații.',
              },
              {
                role: 'user',
                content: `Interogare: "${query}"\nJSON array termeni:`,
              },
            ],
            max_tokens: 100,
          }),
        })

        if (grokResp.ok) {
          const grokData = await grokResp.json()
          const content = grokData.choices?.[0]?.message?.content?.trim() || ''
          const match = content.match(/\[[\s\S]*?\]/)
          if (match) {
            const parsed = JSON.parse(match[0])
            if (Array.isArray(parsed) && parsed.length > 0) {
              termeni = parsed.map(t => String(t).toLowerCase().trim()).filter(Boolean)
            }
          }
        }
      } catch (e) {
        console.log('[legislatie/cauta] Grok fallback la query original:', e.message)
      }
    }

    console.log(`[legislatie/cauta] "${query}" → [${termeni.join(', ')}]`)

    let dbQuery = supabase
      .from('legislatie_articole')
      .select('act_normativ, domeniu, nr_articol, titlu_articol, text_articol, mo_nr, mo_data')
      .limit(40)

    if (domeniu && domeniu !== 'Toate') {
      dbQuery = dbQuery.eq('domeniu', domeniu)
    }

    const orFilter = termeni
      .slice(0, 4)
      .flatMap(t => [
        `text_articol.ilike.%${t}%`,
        `titlu_articol.ilike.%${t}%`,
        `nr_articol.ilike.%${t}%`,
      ])
      .join(',')

    const { data, error } = await dbQuery.or(orFilter)

    if (error) {
      console.log('[legislatie/cauta] Supabase eroare:', error.message)
      return res.status(500).json({ error: error.message })
    }

    // Grupeaza pe act normativ
    const grouped = {}
    for (const art of (data || [])) {
      if (!grouped[art.act_normativ]) {
        grouped[art.act_normativ] = { act_normativ: art.act_normativ, domeniu: art.domeniu, articole: [] }
      }
      grouped[art.act_normativ].articole.push({
        nr: art.nr_articol,
        titlu: art.titlu_articol,
        text: art.text_articol,
        moNr: art.mo_nr,
        moData: art.mo_data,
      })
    }

    const rezultate = Object.values(grouped)
    console.log(`[legislatie/cauta] ${data?.length || 0} articole din ${rezultate.length} acte`)

    res.json({ rezultate, termeni })
  } catch (e) {
    console.log('[legislatie/cauta] Eroare:', e.message)
    res.status(500).json({ error: e.message })
  }
})

async function scrapeToate() {
  if (!supabase) return console.log('[cron] Supabase not configured, skip')
  console.log('[cron] Start scraping toate legile...')
  for (const lege of LEGI) {
    try {
      const articole = await scrapeLege(lege.id, lege.act, lege.domeniu)
      if (!articole.length) { console.log(`[cron] ✗ 0 articole: ${lege.act}`); continue }
      await supabase.from('legislatie_articole').delete().eq('act_normativ', lege.act)
      for (let i = 0; i < articole.length; i += 500) {
        await supabase.from('legislatie_articole').insert(articole.slice(i, i + 500))
      }
      console.log(`[cron] ✓ ${lege.act}: ${articole.length} articole`)
    } catch (e) {
      console.log(`[cron] ✗ ${lege.act}:`, e.message)
    }
  }
  console.log('[cron] Scraping finalizat.')
}

// Cron: in fiecare duminica la 03:00
cron.schedule('0 3 * * 0', () => {
  console.log('[cron] Pornit scraping saptamanal legislatie...')
  scrapeToate()
}, { timezone: 'Europe/Bucharest' })

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Lexio scraper pornit pe portul ${PORT}`))
