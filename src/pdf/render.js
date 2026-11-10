// Rendu PDF A4 : template Handlebars -> HTML -> PDF via Chromium headless (Puppeteer).
// Un seul navigateur partagé, une page par rendu, 2 rendus simultanés au plus (RAM Render).
// Polices embarquées en base64 : aucun appel réseau pendant le rendu.

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const { factureVersTemplate, contratVersTemplate } = require('./mappers');

const TPL_DIR = path.join(__dirname, 'templates');
const TZ = 'Europe/Paris';
const CONCURRENCE_MAX = 2;

// ── Polices et CSS (chargés une fois) ─────────────────────────────────────────

const FONTS = [
  ['Plus Jakarta Sans', '@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-%W-normal.woff2', [400, 500, 600, 700, 800]],
  ['Space Grotesk', '@fontsource/space-grotesk/files/space-grotesk-latin-%W-normal.woff2', [400, 500, 600, 700]],
];
const fontFaces = FONTS.flatMap(([famille, chemin, graisses]) => graisses.map(g => {
  const b64 = fs.readFileSync(require.resolve(chemin.replace('%W', g))).toString('base64');
  return `@font-face{font-family:'${famille}';font-weight:${g};src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
})).join('\n');
// Logo Cubi embarqué en data URI (le réseau est bloqué pendant le rendu), ajouté au CSS
// pour ne pas ouvrir de nouveau {{{ }}} dans les templates
const logoB64 = fs.readFileSync(path.join(__dirname, 'assets', 'logo-cubi.png')).toString('base64');
const css = fs.readFileSync(path.join(TPL_DIR, 'cubi-print.css'), 'utf8')
  + `\n.mark.logo{background:url(data:image/png;base64,${logoB64}) center/contain no-repeat;border-radius:0}`;

// ── Helpers Handlebars (instance isolée) ──────────────────────────────────────
// {{ }} échappe le HTML. {{{ }}} est réservé à css et fontFaces.

const hbs = Handlebars.create();

// Centimes (entier) -> « 1 625,00 € ». Refuse les montants non entiers (euros passés par erreur).
hbs.registerHelper('money', centimes => {
  if (!Number.isInteger(centimes)) throw new Error(`money : montant en centimes attendu, reçu ${centimes}`);
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(centimes / 100);
});

// Date seule ('YYYY-MM-DD') affichée telle quelle ; date-heure convertie en heure de Paris
hbs.registerHelper('date', d => {
  if (d == null) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d.split('-').reverse().join('/');
  return new Date(d).toLocaleDateString('fr-FR', { timeZone: TZ });
});
hbs.registerHelper('datetime', d => (d == null ? ''
  : new Date(d).toLocaleString('fr-FR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })));
hbs.registerHelper('iso', d => (d == null ? '' : new Date(d).toISOString().replace('T', ' ').slice(0, 19)));

// Texte placé dans une chaîne CSS (content:"…" des marges @page) : l'échappement HTML n'y est pas décodé.
hbs.registerHelper('cssText', s => new hbs.SafeString(
  String(s ?? '').replace(/[\\"]/g, '\\$&').replace(/</g, '\\3C ').replace(/[\r\n]+/g, ' ')
));

const compiles = {};
function renderHtml(nom, data) {
  compiles[nom] ??= hbs.compile(fs.readFileSync(path.join(TPL_DIR, `${nom}.hbs`), 'utf8'));
  return compiles[nom]({ ...data, css, fontFaces });
}

// ── Navigateur partagé ────────────────────────────────────────────────────────

let navigateur = null; // Promise<Browser>

function getNavigateur() {
  if (!navigateur) {
    navigateur = puppeteer.launch({
      // chrome-headless-shell : binaire plus léger que Chrome complet, seul installé par le build Render
      headless: 'shell',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }).then(browser => {
      // Crash ou fermeture : la prochaine demande relance un navigateur
      browser.on('disconnected', () => { navigateur = null; });
      return browser;
    }, err => {
      navigateur = null;
      throw err;
    });
  }
  return navigateur;
}

async function closeBrowser() {
  const courant = navigateur;
  navigateur = null;
  if (courant) await (await courant).close().catch(() => {});
}

// Limiteur de concurrence (équivalent p-limit, qui n'existe plus qu'en ESM)
let actifs = 0;
const file = [];
function limiter(fn) {
  return new Promise((resolve, reject) => {
    file.push({ fn, resolve, reject });
    suivant();
  });
}
function suivant() {
  if (actifs >= CONCURRENCE_MAX || !file.length) return;
  actifs++;
  const { fn, resolve, reject } = file.shift();
  Promise.resolve().then(fn).then(resolve, reject).finally(() => { actifs--; suivant(); });
}

async function rendreUneFois(browser, html) {
  const page = await browser.newPage();
  try {
    // Défense en profondeur : aucun script de page (les données sont déjà échappées par Handlebars)
    // et seules les ressources inline (data:) sont autorisées
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', req => (/^(data|about):/.test(req.url()) ? req.continue() : req.abort()));
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    await page.close().catch(() => {});
  }
}

function renderPdf(nom, data) {
  const html = renderHtml(nom, data);
  return limiter(async () => {
    const browser = await getNavigateur();
    try {
      return await rendreUneFois(browser, html);
    } catch (err) {
      // Le navigateur a planté pendant le rendu : une seule nouvelle tentative sur un navigateur neuf
      if (browser.connected) throw err;
      if (navigateur && (await navigateur) === browser) navigateur = null;
      return rendreUneFois(await getNavigateur(), html);
    }
  });
}

// ── API interne ───────────────────────────────────────────────────────────────

function renderFacturePdf(facture) {
  return renderPdf('facture', factureVersTemplate(facture));
}

function renderContratPdf(contrat, options = {}) {
  return renderPdf('contrat', contratVersTemplate(contrat, options));
}

module.exports = { renderFacturePdf, renderContratPdf, renderPdf, renderHtml, closeBrowser };
