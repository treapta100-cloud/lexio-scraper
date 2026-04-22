const express = require('express')
const puppeteer = require('puppeteer-core')

const app = express()
app.use(express.json())

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

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.post('/cauta-dosar', async (req, res) => {
  const numar_dosar = req.body?.numar_dosar?.trim()
  if (!numar_dosar || numar_dosar.length < 3) {
    return res.json({ rezultate: [], error: 'Lipseste numar_dosar' })
  }

  try {
    const result = await scrapeDosar(numar_dosar)
    res.json(result)
  } catch (err) {
    console.error('[scraper] Eroare:', err.message)
    res.json({ rezultate: [], error: err.message })
  }
})


const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Lexio scraper pornit pe portul ${PORT}`))
