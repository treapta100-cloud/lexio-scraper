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
    console.log('[scraper] Caut link dosar pentru parti...')

    // Incearca sa dea click pe randul dosarului sau pe primul link din rezultate
    const clicked = await page.evaluate((numar, sel) => {
      const container = document.querySelector(sel)
      if (!container) return 'no-container'

      // Cauta link care contine numarul dosarului
      const allLinks = Array.from(container.querySelectorAll('a'))
      let target = allLinks.find(a => a.textContent.trim().includes(numar))
      if (!target && allLinks.length > 0) target = allLinks[0]

      if (!target) {
        // Incearca click pe primul rand din tabel
        const rows = container.querySelectorAll('tr')
        for (const row of rows) {
          if (row.textContent.includes(numar)) {
            const link = row.querySelector('a')
            if (link) { link.click(); return 'row-link' }
            row.click()
            return 'row-click'
          }
        }
        return 'no-link'
      }

      target.click()
      return 'link-click'
    }, numarDosar, selResults)

    console.log(`[scraper] Click rezultat: ${clicked}`)
    if (clicked === 'no-container' || clicked === 'no-link') return []

    // Asteapta sa se incarce continutul (fie navigare, fie expand in pagina)
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
      new Promise(r => setTimeout(r, 5000)),
    ])

    await new Promise(r => setTimeout(r, 2000))

    // Extrage partile din pagina de detaliu
    const parti = await page.evaluate(() => {
      const text = document.body?.innerText ?? ''
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

      const result = []
      let inPartiSection = false

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const lower = line.toLowerCase()

        // Detecteaza inceputul sectiunii Parti
        if (lower === 'parti' || lower === 'părți' || lower === 'parti in dosar' || lower === 'parti dosar') {
          inPartiSection = true
          continue
        }

        if (inPartiSection) {
          // Opreste la urmatoarea sectiune
          if (
            lower.includes('termen') || lower.includes('sedinte') ||
            lower.includes('dosar') || lower.includes('document') ||
            lower.includes('cale de atac') || lower.includes('informatii')
          ) break

          // Extrage numele partii — linie cu litere mari, fara cifre multe
          // Format tipic: "POPESCU ION" sau "POPESCU ION - Reclamant" sau "SC FIRMA SRL"
          const name = line.split(' - ')[0].split('\t')[0].trim()
          if (
            name.length >= 3 &&
            name.length <= 80 &&
            /[A-ZĂÎȘȚÂ]/.test(name) &&
            !/^\d+$/.test(name) &&
            !result.includes(name)
          ) {
            result.push(name)
          }
        }
      }

      // Fallback: daca sectiunea nu a fost detectata, cauta pattern-uri de nume
      if (result.length === 0) {
        const partePatterns = [
          /reclamant[:\s]+([A-ZĂÎȘȚÂ][A-ZĂÎȘTÂa-zăîșță\s\-\.]+)/gi,
          /parat[:\s]+([A-ZĂÎȘȚÂ][A-ZĂÎȘTÂa-zăîșță\s\-\.]+)/gi,
          /intervenient[:\s]+([A-ZĂÎȘȚÂ][A-ZĂÎȘTÂa-zăîșță\s\-\.]+)/gi,
          /petent[:\s]+([A-ZĂÎȘȚÂ][A-ZĂÎȘTÂa-zăîșță\s\-\.]+)/gi,
          /intimat[:\s]+([A-ZĂÎȘȚÂ][A-ZĂÎȘTÂa-zăîșță\s\-\.]+)/gi,
        ]

        for (const pattern of partePatterns) {
          const matches = [...text.matchAll(pattern)]
          for (const m of matches) {
            const name = m[1].trim().replace(/\s+/g, ' ')
            if (name.length >= 3 && name.length <= 80 && !result.includes(name)) {
              result.push(name)
            }
          }
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
