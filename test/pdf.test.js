const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { renderFacturePdf, renderContratPdf, renderPdf, renderHtml, closeBrowser } = require('../src/pdf/render');
const { libellePeriode } = require('../src/pdf/mappers');
const { getEmetteur } = require('../src/pdf/emetteur');
const sample = require('../reference/sample-data.json');

after(closeBrowser);

// Plus Jakarta Sans (bloc méta) remplace le tiret entre chiffres par un glyphe extrait en U+2212
const texte = async pdf => (await pdfParse(pdf)).text.replace(/−/g, '-');

// Lignes telles que lues en base (migration 004), à la convention de src/pdf/mappers.js
const FACTURE = {
  numero: 'FAC-2026-0142',
  type: 'facture',
  contrat_numero: 'CTR-2026-0037',
  periode_debut: '2026-11-01',
  periode_fin: '2026-11-30',
  date_emission: '2026-11-06',
  date_echeance: '2026-12-06',
  date_paiement: null,
  statut: 'emise',
  lignes: sample.facture.lines,
  total_ht_centimes: sample.facture.invoice.totalHtCents,
  total_tva_centimes: 43420,
  total_ttc_centimes: sample.facture.invoice.totalTtcCents,
  ventilation_tva: sample.facture.invoice.vatBreakdown,
  client_snapshot: sample.facture.client,
  emetteur_snapshot: sample.facture.issuer,
};

const CONTRAT = {
  numero: 'CTR-2026-0037',
  donnees: {
    client: sample.contrat.client,
    offre: { nom: 'Licence 2', badge: 'Volume' },
    facturation: { libelle: 'Mensuelle, à terme à échoir' },
    etablissements: [
      { ecoleId: 'e1', nom: 'Lycée Les Tilleuls', siret: '98765432100045', quantite: 60, prixUnitaireCentimes: 400 },
      { ecoleId: 'e2', nom: 'Collège Les Platanes', siret: '98765432100052', quantite: 45, prixUnitaireCentimes: 400 },
    ],
  },
  duree_mois: 12,
  date_debut: '2026-11-01',
  signataire_nom: 'Mme S. Bernard',
  signataire_fonction: 'Proviseure',
  signataire_email: 's.bernard@tilleuls.fr',
  sha256_original: sample.contrat.proof.originalHash,
  date_signature_cubi: null,
};

test('helpers : money en centimes, dates en Europe/Paris, iso en UTC', () => {
  const html = renderHtml('facture', {
    ...sample.facture,
    // 23h30 UTC le 5 = 6 novembre à Paris
    invoice: { ...sample.facture.invoice, issuedAt: '2026-11-05T23:30:00Z', totalTtcCents: 162500 },
  });
  assert.match(html, /1\s625,00\s€/);
  assert.match(html, /06\/11\/2026/);
  assert.throws(() => renderHtml('facture', { ...sample.facture, invoice: { ...sample.facture.invoice, totalHtCents: 21.71 } }),
    /centimes attendu/);
  assert.equal(libellePeriode('2026-11-01', '2026-11-30'), 'Nov. 2026');
  assert.equal(libellePeriode('2026-11-01', '2027-01-31'), '01/11/2026 – 31/01/2027');
});

test('échappement : le HTML des données est échappé, {{{ }}} réservé à css et fontFaces', () => {
  const html = renderHtml('facture', { ...sample.facture, client: { ...sample.facture.client, name: '<script>alert(1)</script>' } });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));

  const contrat = renderHtml('contrat', { ...sample.contrat, issuer: { ...sample.contrat.issuer, legalName: 'L\'École "test"' } });
  assert.ok(contrat.includes('content:"L\'École \\"test\\" · Contrat'), 'texte CSS du pied de page échappé pour CSS');

  for (const f of ['facture.hbs', 'contrat.hbs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pdf', 'templates', f), 'utf8');
    const triples = [...src.matchAll(/\{\{\{\s*([^}\s]+)/g)].map(m => m[1]);
    assert.deepEqual(triples.sort(), ['css', 'fontFaces'], f);
  }
});

test('émetteur : « À COMPLÉTER » quand l\'env est vide', () => {
  const avant = process.env.CUBI_SIRET;
  delete process.env.CUBI_SIRET;
  try {
    assert.equal(getEmetteur().siret, 'À COMPLÉTER');
  } finally {
    if (avant !== undefined) process.env.CUBI_SIRET = avant;
  }
});

test('renderPdf : les deux templates de référence se rendent', async () => {
  for (const nom of ['facture', 'contrat']) {
    const pdf = await renderPdf(nom, sample[nom]);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  }
});

test('renderFacturePdf : PDF valide avec le numéro de facture', async () => {
  const pdf = await renderFacturePdf(FACTURE);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const t = await texte(pdf);
  assert.ok(t.includes('FAC-2026-0142'));
  assert.ok(t.includes('CTR-2026-0037'));
  assert.ok(t.includes('Nov. 2026'));
});

test('renderFacturePdf : un avoir affiche sa facture d\'origine', async () => {
  const t = await texte(await renderFacturePdf({
    ...FACTURE, numero: 'AV-2026-0003', type: 'avoir', facture_origine_numero: 'FAC-2026-0142',
  }));
  assert.ok(t.includes('AV-2026-0003'));
  assert.ok(t.includes('Avoir'));
  assert.ok(t.includes('FAC-2026-0142'));
  // Pas de règlement ni de pénalités sur un avoir
  assert.ok(t.replace(/\s+/g, ' ').includes('Montant porté au crédit du client, imputé sur les prochaines factures ou remboursé sur demande.'));
  assert.ok(!/RÈGLEMENT|Règlement par virement/i.test(t));
  assert.ok(!t.includes('pénalités'));

  const facture = await texte(await renderFacturePdf(FACTURE));
  assert.ok(facture.includes('pénalités'), 'la facture garde ses mentions de retard');
});

test('renderContratPdf : non signé, puis signé avec certificat de preuve', async () => {
  delete process.env.CUBI_SIGNATURE_PNG_BASE64;
  const brouillon = await renderContratPdf(CONTRAT);
  assert.equal(brouillon.subarray(0, 4).toString(), '%PDF');
  let t = await texte(brouillon);
  assert.ok(t.includes('CTR-2026-0037'));
  assert.ok(t.includes('Collège Les Platanes'), 'une ligne par établissement pour un groupe');
  assert.ok(t.includes('En attente de contre-signature'));
  assert.ok(!t.includes('Certificat de signature'));

  // PNG 1x1 transparent
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const signe = await renderContratPdf(CONTRAT, {
    signature: { png, signedAt: '2026-11-09T14:03:22Z', mention: 'Lu et approuvé', proofId: 'SIG-7F3A-92C1' },
    preuve: {
      verifyUrl: 'https://cubi.fr/verify/SIG-7F3A-92C1',
      evenements: [
        { horodatage: '2026-11-08T09:12:00Z', type: 'genere', acteur: 'admin@cubi.fr', ip: null },
        { horodatage: '2026-11-09T14:03:22Z', type: 'signe', acteur: 's.bernard@tilleuls.fr', ip: '81.250.12.4' },
      ],
    },
  });
  t = await texte(signe);
  assert.ok(t.includes('Certificat de signature'));
  assert.ok(t.includes('SIG-7F3A-92C1'));
  // L'empreinte peut être coupée en fin de ligne (word-break) : comparaison sans espaces
  assert.ok(t.replace(/\s/g, '').includes(CONTRAT.sha256_original));
  assert.ok(t.includes('81.250.12.4'));
});

test('rendus concurrents : 5 rendus en parallèle sur le navigateur partagé', async () => {
  const pdfs = await Promise.all(Array.from({ length: 5 }, () => renderFacturePdf(FACTURE)));
  for (const pdf of pdfs) assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});
