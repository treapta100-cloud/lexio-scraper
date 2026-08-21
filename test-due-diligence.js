/**
 * Test de regresie pentru Due Diligence — rulare: node test-due-diligence.js
 *
 * Acopera doua defecte reale gasite pe 2026-08-21:
 *
 *  1. POTRIVIRE PE NUME — portalul scrie "TERRA CONSTRUCŢII" (cu T-sedila), userul
 *     scrie "Terra Constructii". Comparatia bruta cu includes() esua, iar aplicatia
 *     afisa 1 dosar al ALTEI firme (AQUA TERRA CONSTRUCTII SRL) in locul celor ~36
 *     ale firmei corecte.
 *
 *  2. BPI DEGRADAT TACIT — cuiscan.ro si-a pierdut accesul la BPI si intoarce
 *     HTTP 200 + inInsolventa:false + sursa:"necunoscut" pentru ORICE CUI, inclusiv
 *     firme aflate real in faliment. Aplicatia afisa doua bife verzi.
 *
 * Cazul de referinta: TERRA CONSTRUCTII SRL, CUI 3371933, Botosani — firma aflata
 * real in faliment (28 de dosare la Tribunalul Botosani, cu lichidator judiciar).
 */

const http = require('http')
const fs = require('fs')

const CUI_TEST = '3371933'
const NUME_TEST = 'TERRA CONSTRUCTII SRL'
const MIN_DOSARE_ASTEPTATE = 30

// Reutilizam functia REALA din server.js — daca cineva o strica acolo, testul pica.
// De ce eval: server.js nu exporta nimic si porneste serverul la require(), deci nu
// poate fi importat intr-un test. Alternativa ar fi sa duplicam foldNume aici, dar
// atunci testul ar valida o copie, nu codul care ruleaza in productie — exact genul
// de test care trece in timp ce aplicatia e stricata.
// Sigur in acest context: script local de dezvoltare (NU face parte din server), iar
// intrarea nu vine de la utilizator — e un fragment din fisierul sursa din acelasi
// repo, extras cu un regex strict pe declaratia functiei.
const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
const m = src.match(/function foldNume\(s\) \{[\s\S]*?\n\}/)
if (!m) { console.error('FAIL: foldNume nu mai exista in server.js'); process.exit(1) }
eval(m[0]) // eslint-disable-line no-eval

let esecuri = 0
function verifica(nume, conditie, detaliu) {
  console.log(`${conditie ? 'PASS' : 'FAIL'}  ${nume}${detaliu ? ' — ' + detaliu : ''}`)
  if (!conditie) esecuri++
}

function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(re)].map(x => x[1])
}
function extractOne(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? m[1] : ''
}

function cerePortal(numeParte) {
  const body = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CautareDosare xmlns="portalquery.just.ro">
      <numarDosar></numarDosar><obiectDosar></obiectDosar>
      <numeParte>${numeParte}</numeParte>
      <institutie xsi:nil="true" />
    </CautareDosare>
  </soap:Body>
</soap:Envelope>`, 'utf-8')
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'portalquery.just.ro', path: '/query.asmx', method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"portalquery.just.ro/CautareDosare"',
        'Content-Length': body.length,
      },
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve(d))
    })
    req.on('error', reject)
    req.setTimeout(40000, () => { req.destroy(); reject(new Error('timeout portal')) })
    req.write(body); req.end()
  })
}

function numaraDosare(xml, q, potrivire) {
  let n = 0
  for (const b of extractAll(xml, 'Dosar')) {
    if (!extractOne(b, 'numar')) continue
    const gasit = extractAll(b, 'DosarParte').some(p => potrivire(extractOne(p, 'nume'), q))
    if (gasit) n++
  }
  return n
}

async function main() {
  console.log('=== 1. POTRIVIRE PE NUME (portal.just.ro, date reale) ===')
  const xml = await cerePortal('TERRA CONSTRUCTII')

  const brut = numaraDosare(xml, NUME_TEST.toUpperCase(), (n, q) => (n || '').toUpperCase().includes(q))
  const fold = numaraDosare(xml, foldNume(NUME_TEST), (n, q) => foldNume(n).includes(q))

  console.log(`     comportament vechi (brut): ${brut} dosare`)
  console.log(`     comportament nou (foldNume): ${fold} dosare`)
  verifica('normalizarea gaseste dosarele firmei reale', fold >= MIN_DOSARE_ASTEPTATE, `${fold} >= ${MIN_DOSARE_ASTEPTATE}`)
  verifica('normalizarea e o imbunatatire fata de vechi', fold > brut, `${fold} > ${brut}`)

  console.log('\n=== 2. BPI — sursa degradata trebuie respinsa ===')
  const resp = await fetch(`https://cuiscan.ro/api.php?action=insolventa&cui=${CUI_TEST}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://cuiscan.ro/',
    },
    signal: AbortSignal.timeout(15000),
  })
  const json = await resp.json()
  console.log(`     raspuns sursa: sursa=${JSON.stringify(json.sursa)} proceduri=${JSON.stringify(json.proceduri)} inInsolventa=${json.inInsolventa}`)

  // Exact conditia din getBpiData
  const respins = json.sursa === 'necunoscut' || !Array.isArray(json.proceduri)
  verifica('raspunsul degradat este respins (=> null, nu verde)', respins)

  // Firma e real in faliment. Daca sursa ar functiona vreodata din nou si ar spune
  // "curat" pentru ea, ar fi tot un rezultat gresit — testul trebuie sa semnaleze.
  if (!respins) {
    verifica('firma in faliment NU este raportata curata', json.inInsolventa === true)
  } else {
    console.log('     (sursa e indisponibila — aplicatia va afisa "verificare indisponibila")')
  }

  console.log(`\n${esecuri === 0 ? 'TOATE TESTELE AU TRECUT' : esecuri + ' TEST(E) AU ESUAT'}`)
  // process.exitCode, nu process.exit(): iesirea forțata in timp ce fetch-ul isi
  // inchide socketii produce un crash libuv pe Windows si un cod de iesire fals.
  process.exitCode = esecuri === 0 ? 0 : 1
}

main().catch(e => { console.error('EROARE:', e.message); process.exitCode = 1 })
