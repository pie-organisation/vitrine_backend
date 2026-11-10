// Calculs de facturation, sans base
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  arrondi, joursDansMois, finDeMois, moisSuivant, periodeDuMois, prorata,
  lignesFacture, totaux, lignesAvoirTotal, lignesAvoirPartiel, verifierPlafondAvoir,
} = require('../src/services/calculFacture');
const { factureEcole, statutEcole } = require('../src/services/vueFacture');

const ECOLE = {
  offre: { nom: 'Licence 2' },
  etablissements: [{ ecoleId: 'e1', nom: 'Lycée Les Tilleuls', siret: '1', quantite: 40, prixUnitaireCentimes: 400 }],
};
const GROUPE = {
  offre: { nom: 'Licence 3' },
  etablissements: [
    { ecoleId: 'e1', nom: 'Collège A', siret: '1', quantite: 70, prixUnitaireCentimes: 300 },
    { ecoleId: 'e2', nom: 'Collège B', siret: '2', quantite: 45, prixUnitaireCentimes: 300 },
  ],
};

test('calendrier : mois civils, années bissextiles', () => {
  assert.equal(joursDansMois('2026-11-15'), 30);
  assert.equal(joursDansMois('2028-02-01'), 29);
  assert.equal(joursDansMois('2027-02-01'), 28);
  assert.equal(finDeMois('2026-12-03'), '2026-12-31');
  assert.equal(moisSuivant('2026-12-15'), '2027-01-01');
});

test('période du mois en cours, bornée par le début du contrat', () => {
  assert.deepEqual(periodeDuMois('2026-11-20', '2026-11-15'), { debut: '2026-11-15', fin: '2026-11-30' });
  assert.deepEqual(periodeDuMois('2026-12-03', '2026-11-15'), { debut: '2026-12-01', fin: '2026-12-31' });
  assert.equal(periodeDuMois('2026-11-20', '2027-01-01'), null, 'contrat qui commence plus tard');
});

test('prorata au jour près, dans un seul mois', () => {
  assert.deepEqual(prorata('2026-11-15', '2026-11-30'), { jours: 16, joursMois: 30 });
  assert.deepEqual(prorata('2026-11-01', '2026-11-30'), { jours: 30, joursMois: 30 });
  assert.deepEqual(prorata('2028-02-10', '2028-02-29'), { jours: 20, joursMois: 29 });
  assert.throws(() => prorata('2026-11-15', '2026-12-14'), e => e.status === 422);
  assert.throws(() => prorata('2026-11-15', '2026-11-14'), e => e.status === 422);
});

test('lignes : école, mois complet puis prorata arrondi ligne par ligne', () => {
  let [l] = lignesFacture(ECOLE, { periodeDebut: '2026-11-01', periodeFin: '2026-11-30' });
  assert.deepEqual(l, {
    label: 'Abonnement Licence 2', description: 'Période du 01/11/2026 au 30/11/2026',
    quantity: 40, unitPriceCents: 400, vatRate: 20, totalHtCents: 16000,
  });
  // 40 × 4,00 € × 16/30 = 85,333… -> 85,33 €
  [l] = lignesFacture(ECOLE, { periodeDebut: '2026-11-15', periodeFin: '2026-11-30' });
  assert.equal(l.totalHtCents, 8533);
  assert.equal(l.description, 'Prorata 16/30 jours, du 15/11/2026 au 30/11/2026');
  assert.equal(l.unitPriceCents, 400, 'prix mensuel affiché, le prorata est dans le total');
});

test('lignes : une ligne par établissement pour un groupe', () => {
  const lignes = lignesFacture(GROUPE, { periodeDebut: '2026-11-01', periodeFin: '2026-11-30' });
  assert.deepEqual(lignes.map(l => [l.label, l.quantity, l.totalHtCents]), [
    ['Abonnement Licence 3 — Collège A', 70, 21000],
    ['Abonnement Licence 3 — Collège B', 45, 13500],
  ]);
});

test('frais de mise en service : première facture et montant > 0 uniquement', () => {
  const p = { periodeDebut: '2026-11-15', periodeFin: '2026-11-30' };
  assert.equal(lignesFacture(ECOLE, { ...p, premiere: true, fraisMiseEnServiceCentimes: 0 }).length, 1);
  assert.equal(lignesFacture(ECOLE, { ...p, premiere: false, fraisMiseEnServiceCentimes: 15000 }).length, 1);
  const lignes = lignesFacture(ECOLE, { ...p, premiere: true, fraisMiseEnServiceCentimes: 15000 });
  assert.equal(lignes.length, 2);
  assert.deepEqual(lignes[1], {
    label: 'Frais de mise en service', description: 'Facturés une seule fois',
    quantity: 1, unitPriceCents: 15000, vatRate: 20, totalHtCents: 15000,
  });
});

test('totaux : TVA ventilée sur la base HT de chaque taux, pas ligne par ligne', () => {
  const l = (totalHtCents, vatRate = 20) => ({ label: 'x', quantity: 1, unitPriceCents: totalHtCents, vatRate, totalHtCents });
  // 3 lignes à 0,03 € : TVA ligne à ligne = 3 × 0,01 ; sur la base 0,09 € = 0,02
  let t = totaux([l(3), l(3), l(3)]);
  assert.deepEqual(t, {
    totalHtCents: 9, totalTvaCents: 2, totalTtcCents: 11,
    ventilation: [{ rate: 20, baseCents: 9, amountCents: 2 }],
  });

  t = totaux(lignesFacture(GROUPE, { periodeDebut: '2026-11-01', periodeFin: '2026-11-30' }));
  assert.equal(t.totalHtCents, 34500);
  assert.equal(t.totalTvaCents, 6900);
  assert.equal(t.totalTtcCents, 41400);

  t = totaux([l(1000, 20), l(1000, 5.5), l(500, 20)]);
  assert.deepEqual(t.ventilation.map(v => [v.rate, v.baseCents, v.amountCents]), [[5.5, 1000, 55], [20, 1500, 300]]);
  assert.equal(t.totalTtcCents, t.totalHtCents + t.totalTvaCents);
});

test('arrondi symétrique pour les montants négatifs', () => {
  assert.equal(arrondi(12.5), 13);
  assert.equal(arrondi(-12.5), -13);
  assert.equal(arrondi(-12.4), -12);
});

test('avoir total : reprend la facture en négatif, totaux exactement opposés', () => {
  const lignes = lignesFacture(GROUPE, { periodeDebut: '2026-11-15', periodeFin: '2026-11-30' });
  const facture = { numero: 'FAC-2026-0001', lignes };
  const avoir = lignesAvoirTotal(facture, 'Erreur de quantité');
  const tf = totaux(lignes);
  const ta = totaux(avoir);
  assert.equal(ta.totalHtCents, -tf.totalHtCents);
  assert.equal(ta.totalTvaCents, -tf.totalTvaCents);
  assert.equal(ta.totalTtcCents, -tf.totalTtcCents);
  assert.equal(avoir[0].quantity, -70);
  assert.match(avoir[0].description, /FAC-2026-0001 — Erreur de quantité/);
  assert.deepEqual(verifierPlafondAvoir({ totalTtcFacture: tf.totalTtcCents, ttcNouvelAvoir: ta.totalTtcCents }),
    { solde: tf.totalTtcCents, soldeApres: 0, total: true });
});

test('avoir partiel : taux de la facture, plafond cumulé', () => {
  const facture = { numero: 'FAC-2026-0002', lignes: lignesFacture(ECOLE, { periodeDebut: '2026-11-01', periodeFin: '2026-11-30' }) };
  const ttcFacture = totaux(facture.lignes).totalTtcCents; // 192,00 €

  const geste = lignesAvoirPartiel(facture, [{ label: 'Geste commercial', prixUnitaireHtCentimes: 5000 }], 'Panne');
  assert.deepEqual(geste[0], {
    label: 'Geste commercial', description: 'Avoir sur la facture FAC-2026-0002 — Panne',
    quantity: -1, unitPriceCents: 5000, vatRate: 20, totalHtCents: -5000,
  });
  const ttcGeste = totaux(geste).totalTtcCents; // -60,00 €
  assert.equal(ttcGeste, -6000);

  // 1er avoir : OK ; 2e qui solde exactement : total ; 3e : refusé
  assert.equal(verifierPlafondAvoir({ totalTtcFacture: ttcFacture, ttcNouvelAvoir: ttcGeste }).total, false);
  assert.equal(verifierPlafondAvoir({ totalTtcFacture: ttcFacture, ttcAvoirsExistants: [-6000], ttcNouvelAvoir: -13200 }).total, true);
  assert.throws(
    () => verifierPlafondAvoir({ totalTtcFacture: ttcFacture, ttcAvoirsExistants: [-6000, -13200], ttcNouvelAvoir: -1 }),
    e => e.status === 422 && e.soldeCentimes === 0
  );
  assert.throws(
    () => verifierPlafondAvoir({ totalTtcFacture: ttcFacture, ttcAvoirsExistants: [-6000], ttcNouvelAvoir: -13201 }),
    /reste à créditer 132,00 €/
  );
  assert.throws(() => verifierPlafondAvoir({ totalTtcFacture: ttcFacture, ttcNouvelAvoir: 0 }), /strictement positif/);
  assert.throws(
    () => lignesAvoirPartiel(facture, [{ label: 'x', prixUnitaireHtCentimes: 100, tauxTva: 5.5 }], 'm'),
    /Taux de TVA 5.5 absent/
  );
});

test('vue école : statuts du front (presentee / en_cours) + annulee et avoir', () => {
  assert.equal(statutEcole({ type: 'facture', statut: 'payee' }), 'presentee');
  assert.equal(statutEcole({ type: 'facture', statut: 'emise' }), 'en_cours');
  assert.equal(statutEcole({ type: 'facture', statut: 'annulee_par_avoir' }), 'annulee');
  assert.equal(statutEcole({ type: 'avoir', statut: 'emise' }), 'avoir');

  const vue = factureEcole({
    id: 'f1', numero: 'FAC-2026-0001', type: 'facture', statut: 'emise',
    date_emission: '2026-11-06', date_echeance: '2026-12-06', date_paiement: null,
    periode_debut: '2026-11-01', periode_fin: '2026-11-30',
    total_ht_centimes: 16000, total_tva_centimes: 3200, total_ttc_centimes: 19200,
    facture_origine_id: null, contrat_numero: 'CTR-2026-0001',
  });
  assert.deepEqual(
    { id: vue.id, reference: vue.reference, date: vue.date, echeance: vue.echeance, statut: vue.statut },
    { id: 'f1', reference: 'FAC-2026-0001', date: '06/11/2026', echeance: '06/12/2026', statut: 'en_cours' }
  );
  assert.match(vue.montant, /^192,00\s€$/);
});
