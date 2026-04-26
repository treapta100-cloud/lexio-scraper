const express = require('express')
const puppeteer = require('puppeteer-core')
const http = require('http')

const app = express()
app.use(express.json({ limit: '10mb' }))

const API_KEY = process.env.SCRAPER_API_KEY

function requireApiKey(req, res, next) {
  if (!API_KEY) return next()
  const key = req.headers['x-api-key']
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

app.use(requireApiKey)

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
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
  const results = []
  let m
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim())
  return results
}

function extractOne(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
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

    for (const b of partiBlocks) {
      const nume = extractOne(b, 'nume')
      if (!nume || vazute.has(nume)) continue
      if (!nume.toUpperCase().includes(qUpper)) continue
      vazute.add(nume)
      rezultate.push({ denumire: nume, cui: null, judet: null, localitate: null })
      if (rezultate.length >= 8) break
    }

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
  const resp = await fetch('https://webservicesp.anaf.ro/PlatitorTvaRest/api/v8/ws/tva', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok) throw new Error(`ANAF HTTP ${resp.status}`)
  const json = await resp.json()
  const firma = json?.found?.[0]
  if (!firma) return null
  return {
    denumire: firma.denumire || null,
    cui: firma.cui || cuiCurat,
    adresa: firma.adresa || null,
    cod_caen: firma.cod_caen || null,
    stare: firma.stare || null,
    data_inregistrare: firma.data_inregistrare || null,
    platitor_tva: firma.scpTVA === true,
    tva_la_incasare: firma.scpTVAincasare === true,
    inactiv: firma.statusInactivi === true,
    e_factura: firma.statusEFactura === true,
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
    capital_social: json?.capital_social || null,
    nr_onrc: json?.numar_reg_com || null,
    judet: json?.judet || null,
    adresa: json?.adresa || null,
    stare: json?.stare || null,
    radiata: json?.radiata ?? false,
    tva_data: json?.tva || null,
    tva_la_incasare: Array.isArray(json?.tva_la_incasare) && json.tva_la_incasare.length > 0,
    telefon: json?.telefon || null,
  }
}

async function getDosarePortal(numeParte) {
  const xml = await httpPost(soapRequestNumeParte(numeParte))
  const dosareBlocks = extractAll(xml, 'Dosar')
  return dosareBlocks.map(b => {
    const sedinteBlocks = extractAll(b, 'DosarSedinta')
    const sedinteFiltrate = sedinteBlocks
      .map(s => ({
        data: extractOne(s, 'data'),
        ora: extractOne(s, 'ora'),
        solutie: extractOne(s, 'solutie'),
      }))
      .filter(s => s.data && new Date(s.data) >= new Date())

    const partiBlocks = extractAll(b, 'DosarParte')
    const parti = partiBlocks.map(p => ({
      nume: extractOne(p, 'nume'),
      calitate: extractOne(p, 'calitateParte'),
    })).filter(p => p.nume)

    return {
      numar: extractOne(b, 'numar'),
      instanta: extractOne(b, 'institutie'),
      obiect: extractOne(b, 'obiect'),
      stadiu: extractOne(b, 'stadiuProcesual'),
      parti,
      termene_viitoare: sedinteFiltrate,
    }
  }).filter(d => d.numar)
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Lexio scraper pornit pe portul ${PORT}`))
