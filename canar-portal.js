// Canar portal.just.ro — aflam noi, primii, cand portalul pica sau isi schimba formatul.
//
// De ce: sincronizarea (/sync-soap) raspunde TACUT „0 sedinte” cand portalul da eroare sau
// schimba structura XML — avocatul nu primeste termenele noi si nimeni nu afla.
//
// Decizii user 17 nov 2026 (nu le schimba fara el):
// - verificare la 2 ore; la esec 2 reincercari la 3 min, abia apoi „pana”;
// - in pana verificare la 15 min; revenire = 2 verificari reusite la rand;
// - email DOAR pe ALERT_EMAIL; liniste 22:00–07:00 → un singur email-rezumat la 07:00;
// - bannerul din aplicatie se APRINDE DOAR MANUAL, din butonul din email (userul decide);
//   se STINGE AUTOMAT la revenire (altfel ar minti avocatii ca portalul e cazut);
// - text banner: „portal.just.ro momentan indisponibil.”
//
// Siguranta: toata logica e prinsa in try/catch — o eroare aici nu are voie sa opreasca serverul.
// Folosim EXACT functia sincronizarii (soapGetDosar), doar ca sa citim.

const crypto = require('crypto')
const express = require('express')

// Dosare publice vechi, de la instante diferite, care NU sunt ale clientilor nostri
// (verificat 17 nov 2026: 0 in tabela dosare). Alarma doar daca pica AMANDOUA.
const DOSARE_TEST = ['1592/103/2013', '2304/101/2013']
const MESAJ_BANNER = 'portal.just.ro momentan indisponibil.'
const INTERVAL_OK_MS = 2 * 60 * 60 * 1000
const REINCERCARI = 2
const PAUZA_REINCERCARE_MS = 3 * 60 * 1000
const OK_PENTRU_REVENIRE = 2
const VALABILITATE_LINK_MS = 7 * 24 * 60 * 60 * 1000
const ORA_LINISTE_START = 22
const ORA_LINISTE_SFARSIT = 7
const TZ = 'Europe/Bucharest'

const stare = {
  mod: 'ok',            // 'ok' | 'pana'
  ultimaVerificare: 0,  // ms; 0 = verifica la primul tick dupa pornire
  okConsecutive: 0,
  panaDe: null,         // Date
  ruleaza: false,
  amanate: [],          // evenimente din intervalul de liniste, trimise intr-un rezumat la 07:00
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function oraBucuresti(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).format(d)) % 24
}
function inLiniste(d = new Date()) {
  const h = oraBucuresti(d)
  return h >= ORA_LINISTE_START || h < ORA_LINISTE_SFARSIT
}
function cand(d) {
  return new Date(d).toLocaleString('ro-RO', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ── Verificarea ──────────────────────────────────────────────────────────────

async function verifica(soapGetDosar) {
  const erori = await Promise.all(DOSARE_TEST.map(async nr => {
    try {
      const { sedinte, parti } = await soapGetDosar(nr)
      return sedinte.length > 0 && parti.length > 0 ? null : `${nr}: raspuns fara sedinte/parti (portal cazut sau format schimbat)`
    } catch (e) {
      return `${nr}: ${e.message}`
    }
  }))
  const lista = erori.filter(Boolean)
  if (lista.length > 0 && lista.length < DOSARE_TEST.length) {
    console.log(`[canar] atentie: un dosar-test nu mai raspunde corect — de inlocuit (${lista.join('; ')})`)
  }
  return { ok: lista.length < DOSARE_TEST.length, motiv: lista.join('; ') }
}

// ── Email ────────────────────────────────────────────────────────────────────

// Prin API-ul HTTPS Resend, NU prin SMTP: Railway Hobby blocheaza porturile SMTP (25/465/587/2525),
// confirmat 17 nov 2026. Fara domeniu verificat, Resend livreaza DOAR catre proprietarul contului
// (treapta100@gmail.com) — de acolo un filtru Gmail redirectioneaza pe fullagenda (decizie user).
// Prefixul [Canar Juridico] din subiect e cheia filtrului: nu-l scoate.
async function trimiteEmail(subiect, text, html) {
  const { RESEND_API_KEY, ALERT_EMAIL } = process.env
  if (!RESEND_API_KEY || !ALERT_EMAIL) {
    console.log('[canar] email neconfigurat — lipsesc variabilele RESEND_API_KEY / ALERT_EMAIL')
    return false
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Juridico Canar <onboarding@resend.dev>', to: [ALERT_EMAIL], subject: `[Canar Juridico] ${subiect}`, text, html }),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) {
      console.log(`[canar] email esuat: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`)
      return false
    }
    console.log(`[canar] email trimis: ${subiect}`)
    return true
  } catch (e) {
    console.log('[canar] email esuat:', e.message)
    return false
  }
}

// ── Linkuri semnate pentru butoane ───────────────────────────────────────────

function semnatura(a, ts, test) {
  const secret = process.env.CANAR_SECRET || ''
  return crypto.createHmac('sha256', secret).update(`${a}|${ts}|${test}`).digest('hex')
}
function bazaUrl() {
  const d = process.env.RAILWAY_PUBLIC_DOMAIN || 'lexio-scraper-production.up.railway.app'
  return `https://${d}`
}
function linkBanner(a, test = false) {
  const ts = Date.now()
  const t = test ? '1' : '0'
  return `${bazaUrl()}/canar/banner?a=${a}&ts=${ts}&t=${t}&s=${semnatura(a, ts, t)}`
}
// Valideaza parametrii; intoarce { a, ts, t } curate sau null.
function valideaza(q) {
  if (!process.env.CANAR_SECRET) return null
  const a = q.a === 'aprinde' || q.a === 'stinge' ? q.a : null
  const t = q.t === '1' ? '1' : q.t === '0' ? '0' : null
  const ts = /^\d{10,16}$/.test(String(q.ts || '')) ? Number(q.ts) : null
  const s = /^[0-9a-f]{64}$/.test(String(q.s || '')) ? String(q.s) : null
  if (!a || !t || !ts || !s) return null
  const varsta = Date.now() - ts
  if (varsta < -5 * 60 * 1000 || varsta > VALABILITATE_LINK_MS) return null
  const corect = Buffer.from(semnatura(a, ts, t), 'hex')
  const primit = Buffer.from(s, 'hex')
  if (corect.length !== primit.length || !crypto.timingSafeEqual(corect, primit)) return null
  return { a, ts, t }
}

// ── Banner (tabela app_notifications, citita de aplicatie la pornire) ────────

async function aprindeBanner(supabaseAdmin) {
  const { data: activ, error: e1 } = await supabaseAdmin.from('app_notifications')
    .select('id').eq('message', MESAJ_BANNER).eq('active', true).limit(1)
  if (e1) throw new Error(e1.message)
  if (activ && activ.length > 0) return 'deja aprins'
  // Rand NOU la fiecare aprindere: aplicatia tine minte „inchis cu X” dupa id —
  // un rand refolosit n-ar mai aparea la a doua pana celor care l-au inchis prima data.
  const { error: e2 } = await supabaseAdmin.from('app_notifications')
    .insert({ message: MESAJ_BANNER, type: 'warning', active: true })
  if (e2) throw new Error(e2.message)
  return 'aprins'
}
async function stingeBanner(supabaseAdmin) {
  // Atinge DOAR randurile canarului (textul exact), niciodata alte anunturi.
  const { data, error } = await supabaseAdmin.from('app_notifications')
    .update({ active: false }).eq('message', MESAJ_BANNER).eq('active', true).select('id')
  if (error) throw new Error(error.message)
  return (data || []).length
}

// ── Mesajele ─────────────────────────────────────────────────────────────────

function buton(href, eticheta, culoare) {
  return `<a href="${href}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${culoare};color:#fff;text-decoration:none;font-weight:600">${eticheta}</a>`
}
function cadru(titlu, corp) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1a202c">
<h2 style="margin:0 0 12px">${titlu}</h2>${corp}
<p style="color:#718096;font-size:12px;margin-top:24px">Canar Juridico — verificare automata portal.just.ro (dosare-test ${DOSARE_TEST.join(', ')}).</p></div>`
}

function mesajPana(motiv, test = false) {
  const link = linkBanner('aprinde', test)
  const subiect = `${test ? '[TEST] ' : ''}⚠️ portal.just.ro indisponibil (din ${cand(stare.panaDe || new Date())})`
  const text = `Portalul nu raspunde corect din ${cand(stare.panaDe || new Date())}.\nMotiv: ${motiv}\n\nBannerul din aplicatie NU s-a aprins. Daca vrei sa-i anunti pe avocati, deschide:\n${link}\n\nLa revenirea portalului primesti alt email, iar bannerul se stinge automat.`
  const html = cadru(`${test ? '[TEST] ' : ''}portal.just.ro nu răspunde`,
    `<p>Portalul nu răspunde corect din <b>${cand(stare.panaDe || new Date())}</b>.</p>
<p style="color:#4a5568;font-size:13px">Motiv tehnic: ${motiv.replace(/[<>&]/g, '')}</p>
<p>Bannerul din aplicație <b>nu</b> s-a aprins. Dacă vrei să-i anunți pe avocați („${MESAJ_BANNER}”):</p>
<p>${buton(link, 'Aprinde bannerul', '#b45309')}</p>
<p style="font-size:13px;color:#4a5568">La revenirea portalului primești alt email, iar bannerul se stinge automat.</p>`)
  return { subiect, text, html }
}
function mesajRevenire(stinse, test = false) {
  const subiect = `${test ? '[TEST] ' : ''}✅ portal.just.ro a revenit`
  const durata = stare.panaDe ? ` (pană între ${cand(stare.panaDe)} și ${cand(new Date())})` : ''
  const b = stinse > 0 ? 'Bannerul din aplicație a fost stins automat.' : 'Bannerul nu era aprins.'
  return {
    subiect,
    text: `Portalul raspunde din nou corect${durata}.\n${b}`,
    html: cadru(`${test ? '[TEST] ' : ''}portal.just.ro a revenit`, `<p>Portalul răspunde din nou corect${durata}.</p><p>${b}</p>`),
  }
}

// Evenimentele din intervalul de liniste se aduna; la 07:00 pleaca un singur email.
async function anunta(mesaj) {
  if (inLiniste()) {
    stare.amanate.push({ la: new Date(), subiect: mesaj.subiect })
    console.log(`[canar] interval de liniste — amanat: ${mesaj.subiect}`)
    return
  }
  await trimiteEmail(mesaj.subiect, mesaj.text, mesaj.html)
}
async function trimiteRezumatDimineata() {
  if (inLiniste() || stare.amanate.length === 0) return
  const lista = stare.amanate.map(e => `${cand(e.la)} — ${e.subiect}`)
  stare.amanate = []
  if (stare.mod === 'pana') {
    const m = mesajPana('pana continua (vezi istoricul de mai jos)')
    await trimiteEmail(`Rezumat noapte: ${m.subiect}`, `${lista.join('\n')}\n\n${m.text}`,
      m.html.replace('<h2', `<p style="font-size:13px;color:#4a5568">${lista.join('<br>')}</p><h2`))
  } else {
    await trimiteEmail('Rezumat noapte: portal.just.ro funcționează acum',
      `Peste noapte:\n${lista.join('\n')}\n\nAcum portalul functioneaza.`,
      cadru('Rezumat noapte — portalul funcționează acum', `<p>${lista.join('<br>')}</p>`))
  }
}

// ── Ciclul ───────────────────────────────────────────────────────────────────

async function tick({ soapGetDosar, supabaseAdmin }) {
  if (stare.ruleaza) return
  stare.ruleaza = true
  try {
    await trimiteRezumatDimineata()
    if (stare.mod === 'ok' && Date.now() - stare.ultimaVerificare < INTERVAL_OK_MS - 60 * 1000) return
    stare.ultimaVerificare = Date.now()

    if (stare.mod === 'ok') {
      let r = await verifica(soapGetDosar)
      for (let i = 0; !r.ok && i < REINCERCARI; i++) {
        console.log(`[canar] esec, reincerc in 3 min (${i + 1}/${REINCERCARI}): ${r.motiv}`)
        await sleep(PAUZA_REINCERCARE_MS)
        r = await verifica(soapGetDosar)
      }
      if (r.ok) { console.log('[canar] portal OK'); return }
      stare.mod = 'pana'
      stare.panaDe = new Date()
      stare.okConsecutive = 0
      console.log(`[canar] PANA declarata: ${r.motiv}`)
      await anunta(mesajPana(r.motiv))
      return
    }

    // In pana: verificare la fiecare tick (15 min)
    const r = await verifica(soapGetDosar)
    if (!r.ok) { stare.okConsecutive = 0; console.log(`[canar] tot pana: ${r.motiv}`); return }
    stare.okConsecutive++
    console.log(`[canar] raspuns OK in pana (${stare.okConsecutive}/${OK_PENTRU_REVENIRE})`)
    if (stare.okConsecutive < OK_PENTRU_REVENIRE) return
    let stinse = 0
    try { stinse = supabaseAdmin ? await stingeBanner(supabaseAdmin) : 0 } catch (e) { console.log('[canar] stingere banner esuata:', e.message) }
    console.log(`[canar] REVENIRE confirmata; bannere stinse: ${stinse}`)
    await anunta(mesajRevenire(stinse))
    stare.mod = 'ok'
    stare.panaDe = null
    stare.okConsecutive = 0
  } catch (e) {
    console.log('[canar] eroare neasteptata (serverul merge mai departe):', e && e.message)
  } finally {
    stare.ruleaza = false
  }
}

// ── Pagini pentru butoane (GET = doar confirmare, POST = actiunea) ──────────

function pagina(titlu, corp) {
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titlu}</title></head>
<body style="font-family:Arial,sans-serif;background:#070F20;color:#E2EAF4;margin:0;padding:32px 20px"><div style="max-width:480px;margin:0 auto">
<h2 style="color:#C9A84C">${titlu}</h2>${corp}</div></body></html>`
}

function init({ app, cron, soapGetDosar, supabaseAdmin }) {
  try {
    const urlenc = express.urlencoded({ extended: false, limit: '2kb' })

    app.get('/canar/banner', (req, res) => {
      const v = valideaza(req.query)
      if (!v) return res.status(403).send(pagina('Link invalid sau expirat', '<p>Linkul nu mai e valabil.</p>'))
      const ce = v.a === 'aprinde' ? `Aprinzi bannerul „${MESAJ_BANNER}” pentru toți avocații?` : 'Stingi bannerul din aplicație?'
      res.send(pagina(v.t === '1' ? 'TEST — confirmare' : 'Confirmare', `<p>${ce}</p>
<form method="post" action="/canar/banner">
<input type="hidden" name="a" value="${v.a}"><input type="hidden" name="ts" value="${v.ts}">
<input type="hidden" name="t" value="${v.t}"><input type="hidden" name="s" value="${semnatura(v.a, v.ts, v.t)}">
<button type="submit" style="padding:14px 24px;border:0;border-radius:8px;background:#b45309;color:#fff;font-size:16px;font-weight:600">${v.a === 'aprinde' ? 'Da, aprinde bannerul' : 'Da, stinge bannerul'}</button>
</form>${v.t === '1' ? '<p style="color:#7A9ABF">Mod TEST: apăsarea nu schimbă nimic în aplicație.</p>' : ''}`))
    })

    app.post('/canar/banner', urlenc, async (req, res) => {
      try {
        const v = valideaza(req.body || {})
        if (!v) return res.status(403).send(pagina('Link invalid sau expirat', '<p>Linkul nu mai e valabil.</p>'))
        if (v.t === '1') {
          console.log(`[canar] TEST buton „${v.a}” apasat — nimic schimbat`)
          return res.send(pagina('TEST reușit', '<p>Butonul funcționează. Fiind test, <b>nimic</b> nu s-a schimbat în aplicație.</p>'))
        }
        if (!supabaseAdmin) return res.status(503).send(pagina('Eroare', '<p>Serverul nu are acces la baza de date.</p>'))
        if (v.a === 'aprinde') {
          const r = await aprindeBanner(supabaseAdmin)
          console.log(`[canar] banner ${r} (manual, din email)`)
          return res.send(pagina(r === 'aprins' ? 'Banner aprins' : 'Bannerul era deja aprins',
            `<p>Avocații îl văd la următoarea deschidere a aplicației. Se stinge automat când portalul revine.</p>`))
        }
        const n = await stingeBanner(supabaseAdmin)
        console.log(`[canar] banner stins manual (${n})`)
        return res.send(pagina('Banner stins', `<p>${n > 0 ? 'Bannerul a fost stins.' : 'Nu era niciun banner aprins.'}</p>`))
      } catch (e) {
        console.log('[canar] eroare buton:', e.message)
        return res.status(500).send(pagina('Eroare', '<p>Acțiunea nu s-a putut face. Încearcă din nou.</p>'))
      }
    })

    // Email de test (doar cu cheia de admin): butoanele din el sunt in mod TEST.
    app.post('/canar/test-email', async (req, res) => {
      if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const m = mesajPana('TEST — portalul functioneaza, acesta e doar un email de proba', true)
      const ok = await trimiteEmail(m.subiect, m.text, m.html)
      res.json({ trimis: ok })
    })

    cron.schedule('*/15 * * * *', () => { tick({ soapGetDosar, supabaseAdmin }) }, { timezone: TZ })
    console.log(`[canar] pornit — verificare la 2 ore, dosare-test ${DOSARE_TEST.join(', ')}`)
  } catch (e) {
    console.log('[canar] nu a putut porni (serverul merge mai departe):', e && e.message)
  }
}

module.exports = { init, _intern: { stare, tick, trimiteEmail, verifica, valideaza, linkBanner, semnatura, inLiniste, mesajPana, mesajRevenire, aprindeBanner, stingeBanner, trimiteRezumatDimineata, MESAJ_BANNER } }
