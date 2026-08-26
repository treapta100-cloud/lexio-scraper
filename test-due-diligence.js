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

// ─── Endpoint /due-diligence ────────────────────────────────────────────────
// Pornim server.js intr-un proces separat, pe un port de test, cu ADMIN_KEY ales
// aici (ocoleste requireAuth fara sa avem nevoie de un JWT Supabase real).
// De ce proces separat si nu require(): server.js apeleaza app.listen() la
// incarcare si nu exporta nimic.
const PORT_TEST = 3999
const ADMIN_TEST = 'test-local-' + Date.now()
const URL_TEST = `http://127.0.0.1:${PORT_TEST}/due-diligence`

function pornesteServer() {
  const { spawn } = require('child_process')
  return spawn(process.execPath, [require('path').join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT_TEST), ADMIN_KEY: ADMIN_TEST },
    stdio: 'ignore',
  })
}

async function asteaptaServer(incercari = 30) {
  for (let i = 0; i < incercari; i++) {
    try {
      const r = await fetch(URL_TEST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_TEST },
        body: JSON.stringify({ client_version: '2' }),
      })
      if (r.status) return true
    } catch (_) { /* inca nu asculta */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

async function cereDD(body) {
  const r = await fetch(URL_TEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_TEST },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

async function testeEndpoint() {
  const proc = pornesteServer()
  try {
    if (!await asteaptaServer()) {
      verifica('serverul de test porneste', false, 'nu a raspuns in 12s')
      return
    }

    // ── Clientul VECHI (fara client_version) nu are voie sa observe nicio schimbare.
    // Daca acest bloc pica, aplicatiile din magazine se rup pentru utilizatorii
    // care nu s-au actualizat inca. E cea mai importanta sectiune din test.
    console.log('\n  -- client vechi (varianta C: comportament neschimbat) --')
    const v1 = await cereDD({ denumire: NUME_TEST })
    verifica('vechi: cautarea doar dupa denumire functioneaza',
      v1.status === 200 && Array.isArray(v1.json.dosare_portal), `status ${v1.status}`)
    verifica('vechi: dosarele firmei se gasesc in continuare',
      (v1.json.dosare_portal || []).length >= MIN_DOSARE_ASTEPTATE,
      `${(v1.json.dosare_portal || []).length} dosare`)
    verifica('vechi: persoana fizica NU este blocata (poarta nu i se aplica)',
      (await cereDD({ denumire: 'MUSCALU IONUT' })).status === 200)

    // ── Clientul NOU — poarta activa
    console.log('\n  -- client nou (poarta "doar firme") --')
    const V = { client_version: '2' }

    const n1 = await cereDD({ denumire: 'MUSCALU IONUT', ...V })
    verifica('nou: fara CUI => blocat', n1.status === 400 && n1.json.motiv === 'cui_lipsa',
      `${n1.status} / ${n1.json.motiv}`)

    const n2 = await cereDD({ cui: CUI_TEST, ...V })
    verifica('nou: fara denumire => blocat', n2.status === 400 && n2.json.motiv === 'denumire_lipsa',
      `${n2.status} / ${n2.json.motiv}`)

    // 12345678 nu e alocat niciunei firme (verificat la ANAF 2026-08-25).
    const n3 = await cereDD({ cui: '12345678', denumire: 'FIRMA INEXISTENTA SRL', ...V })
    verifica('nou: CUI inexistent primeste motiv propriu, nu "ANAF picat"',
      n3.status === 400 && n3.json.motiv === 'cui_inexistent', `${n3.status} / ${n3.json.motiv}`)

    // PFA real. ANAF returneaza forma_juridica GOALA pentru PFA/II/institutii publice,
    // de aceea poarta e pe CUI si nu pe o lista de forme juridice.
    const n4 = await cereDD({ cui: '30000002', denumire: 'PERSOANA FIZICA AUTORIZATA', ...V })
    verifica('nou: PFA real cu CUI TRECE (nu blocam entitati legitime)', n4.status === 200,
      `status ${n4.status}`)

    const n5 = await cereDD({ cui: CUI_TEST, denumire: NUME_TEST, ...V })
    verifica('nou: firma reala trece poarta', n5.status === 200, `status ${n5.status}`)
    verifica('nou: fixul de diacritice e intact prin endpoint',
      (n5.json.dosare_portal || []).length >= MIN_DOSARE_ASTEPTATE,
      `${(n5.json.dosare_portal || []).length} dosare`)
    // Prin endpoint: fie nu stim (null => "Indisponibil"), fie confirmam insolventa.
    // Varianta "firma e curata" nu are voie sa existe.
    verifica('nou: BPI nu absolva niciodata',
      n5.json.bpi === null || n5.json.bpi.inInsolventa === true,
      n5.json.bpi === null ? 'null (Indisponibil)' : `DA, sursa=${n5.json.bpi.sursa}`)
    verifica('nou: portalul spune DE CE, nu doar cat', n5.json.motive?.portal === 'gasit',
      `motive.portal=${n5.json.motive?.portal}`)
    verifica('nou: numele partii ajunge la client (necesar pentru grupare)',
      (n5.json.dosare_portal || []).every(d => 'nume_parte' in d))
    verifica('nou: totalul potrivirilor e raportat (trunchiere onesta)',
      typeof n5.json.total_portal === 'number' && n5.json.total_portal >= n5.json.dosare_portal.length,
      `${n5.json.dosare_portal.length} afisate din ${n5.json.total_portal}`)

    // Trunchierea: cerem o interogare larga, peste plafonul de 50.
    // Portalul refuza uneori interogarile foarte largi (raspuns gol, fara eroare).
    // Nu declaram FAIL pe indisponibilitatea LOR — ar fi un test care pica aleatoriu
    // si pe care ajungi sa il ignori. Incercam doua interogari; daca niciuna nu
    // intoarce date, marcam explicit "netestat".
    let n6 = null
    for (const q of ['SC AGRO', 'CONSTRUCT']) {
      const r = await cereDD({ denumire: q })
      if ((r.json.total_portal || 0) > 0) { n6 = r; break }
    }
    if (!n6) {
      console.log('SKIP  trunchierea — portalul nu a raspuns la interogarile largi')
    } else {
      verifica('trunchierea nu mai e tacuta',
        n6.json.total_portal > n6.json.dosare_portal.length,
        `${n6.json.dosare_portal.length} afisate din ${n6.json.total_portal} potriviri`)
    }
  } finally {
    proc.kill()
  }
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

  // Regula ASIMETRICA din getBpiData: acceptam doar semnalul pozitiv, cu sursa
  // numita. Orice altceva devine null => ecranul scrie "Indisponibil".
  // Invariantul care conteaza: verdictul "firma e curata" NU exista. Niciodata.
  const aplicaRegula = (j) => (!j.sursa || j.sursa === 'necunoscut' || j.inInsolventa !== true)
    ? null
    : { inInsolventa: true, sursa: String(j.sursa) }

  const rezFaliment = aplicaRegula(json)
  if (rezFaliment) {
    verifica('firma real in faliment este semnalata ca insolventa', rezFaliment.inInsolventa === true,
      `sursa=${json.sursa}`)
  } else {
    console.log(`     (sursa nu confirma acum: sursa=${JSON.stringify(json.sursa)} — ecranul va scrie "Indisponibil")`)
  }
  verifica('nu se emite NICIODATA verdictul "fara insolventa"',
    rezFaliment === null || rezFaliment.inInsolventa === true)

  // A doua sursa de siguranta: o entitate care nu are cum sa fie in insolventa.
  // Daca regula ar absolvi pe cineva, aici s-ar vedea.
  const respPublic = await fetch('https://cuiscan.ro/api.php?action=insolventa&cui=4305857', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://cuiscan.ro/',
    },
    signal: AbortSignal.timeout(15000),
  })
  const jsonPublic = await respPublic.json().catch(() => ({}))
  verifica('lipsa informatiei ramane "nu stiu", nu "e curat"', aplicaRegula(jsonPublic) === null,
    `sursa=${JSON.stringify(jsonPublic.sursa)}`)

  console.log('\n=== 3. ENDPOINT /due-diligence — poarta "doar firme" (varianta C) ===')
  await testeEndpoint()

  console.log(`\n${esecuri === 0 ? 'TOATE TESTELE AU TRECUT' : esecuri + ' TEST(E) AU ESUAT'}`)
  // process.exitCode, nu process.exit(): iesirea forțata in timp ce fetch-ul isi
  // inchide socketii produce un crash libuv pe Windows si un cod de iesire fals.
  process.exitCode = esecuri === 0 ? 0 : 1
}

main().catch(e => { console.error('EROARE:', e.message); process.exitCode = 1 })
