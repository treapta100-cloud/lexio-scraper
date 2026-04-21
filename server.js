const express = require('express')
const puppeteer = require('puppeteer-core')

const app = express()
app.use(express.json())

const PORTAL_URL = 'https://portal.just.ro/SitePages/dosare.aspx'

// Selectori portal.just.ro
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

    // Introdu numarul dosarului
    await page.waitForSelector(SEL_INPUT, { timeout: 10000 })
    await page.click(SEL_INPUT, { clickCount: 3 })
    await page.type(SEL_INPUT, numarDosar, { delay: 50 })

    // Aplica filtrul
    await page.waitForSelector(SEL_BTN, { timeout: 5000 })
    await Promise.all([
      page.click(SEL_BTN),
      page.waitForResponse(r => r.url().includes('dosare.aspx'), { timeout: 15000 }),
    ])

    // Asteapta sa se incarce rezultatele
    await new Promise(r => setTimeout(r, 2500))

    // Extrage datele din tabelul de rezultate
    const rezultate = await page.evaluate((selResults, numar) => {
      const container = document.querySelector(selResults)
      if (!container) return []

      const rows = container.querySelectorAll('tr.ms-itmhover, tr[class*="itmhover"], tbody tr')
      const out = []

      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'))
          .map(c => c.innerText.trim())
          .filter(Boolean)

        if (cells.length >= 2) {
          // Incearca sa extraga campurile relevante din celule
          const text = cells.join(' | ')
          const nrMatch = text.match(/\d{1,6}\/\d{2,4}\/\d{4}/)
          out.push({
            numar_dosar: nrMatch ? nrMatch[0] : numar,
            raw: cells,
          })
        }
      })

      // Daca nu am gasit rows structurate, extrage tot textul
      if (out.length === 0) {
        const allText = container.innerText
        const nrMatches = [...allText.matchAll(/\d{1,6}\/\d{2,4}\/\d{4}/g)]
          .map(m => m[0])
          .filter((v, i, a) => a.indexOf(v) === i)

        nrMatches.forEach(nr => {
          out.push({ numar_dosar: nr, raw: [] })
        })
      }

      return out
    }, SEL_RESULTS, numarDosar)

    // Extrage si date structurate din pagina
    const dateStructurate = await page.evaluate((selResults) => {
      const container = document.querySelector(selResults)
      if (!container) return null

      const text = container.innerText

      function gaseste(pattern) {
        const m = text.match(pattern)
        return m ? m[1].trim() : null
      }

      return {
        obiect: gaseste(/[Oo]biect[^:\n]*:\s*([^\n]{3,120})/),
        instanta: gaseste(/[Ii]nstan[tț][aă][^:\n]*:\s*([^\n]{3,80})/),
        parti: [...text.matchAll(/(?:Reclamant|Pârât|Parte|Inculpat)[^:\n]*:\s*([A-ZĂÎȘȚÂ][^\n]{2,80})/gi)]
          .map(m => m[1].trim()).slice(0, 3),
        termene: [...text.matchAll(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/g)]
          .map(m => m[1]).slice(0, 5),
        textComplet: text.slice(0, 2000),
      }
    }, SEL_RESULTS)

    console.log(`[scraper] Rezultate: ${rezultate.length}, date: ${JSON.stringify(dateStructurate?.obiect)}`)

    return {
      rezultate: rezultate.map(r => ({
        numar_dosar: r.numar_dosar,
        instanta: dateStructurate?.instanta ?? null,
        obiect: dateStructurate?.obiect ?? null,
        parti: dateStructurate?.parti ?? [],
        termene_urmatoare: dateStructurate?.termene ?? [],
      })),
      debug: dateStructurate?.textComplet,
    }
  } finally {
    await browser.close()
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
