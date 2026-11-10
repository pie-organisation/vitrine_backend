// /admin/factures — monté dans routes/admin.js (requireAuth + équipe Cubi). Écriture : super_admin.
const router = require('express').Router();
const { z } = require('zod');
const pool = require('../db');
const { requireCubi } = require('../middleware/auth');
const messagerie = require('../messagerie');
const documentStorage = require('../services/documentStorage');
const factures = require('../services/factures');
const { acteurCubi } = require('../services/contrats');
const { STATUT_ADMIN_SQL, STATUTS_ADMIN, factureAdmin, factureDetail } = require('../services/vueFacture');

const PAR_PAGE = 50;
const SANS_PAGINATION_MAX = 1000;

// Factures (aucune BYTEA dans la table) + statut affiché + offre du contrat
const SELECT_VUE = `
  SELECT f.*, c.numero AS contrat_numero, c.donnees->'offre'->>'nom' AS plan,
         o.numero AS facture_origine_numero, ${STATUT_ADMIN_SQL} AS statut_affiche
  FROM facture f
  JOIN contrat c      ON c.id = f.contrat_id
  LEFT JOIN facture o ON o.id = f.facture_origine_id`;

function idValide(req, res, next) {
  if (!messagerie.isUuid(req.params.id)) return res.status(404).json({ error: 'Facture introuvable' });
  next();
}

function repondreErreur(res, next, err) {
  if (err.status === 422) return res.status(422).json({ message: err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// GET /admin/factures?statut=&organisation=&page=
// Renvoie un tableau (forme attendue par le front). Avec ?page=N : 50 par page, total dans X-Total-Count.
router.get('/', async (req, res, next) => {
  try {
    const statut = STATUTS_ADMIN.includes(req.query.statut) ? req.query.statut : null;
    // organisation : une école, un groupe, ou une école membre d'un groupe (factures du groupe incluses)
    const organisation = messagerie.isUuid(req.query.organisation) ? req.query.organisation : null;
    if (req.query.organisation && !organisation) return res.json([]);
    const page = req.query.page ? Math.max(1, parseInt(req.query.page, 10) || 1) : null;

    const filtre = `
      WHERE ($1::text IS NULL OR ${STATUT_ADMIN_SQL} = $1)
        AND ($2::uuid IS NULL OR f.ecole_id = $2 OR f.groupe_scolaire_id = $2
             OR f.groupe_scolaire_id = (SELECT groupe_scolaire_id FROM ecole WHERE id = $2))`;
    const limite = page ? PAR_PAGE : SANS_PAGINATION_MAX;
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `${SELECT_VUE} ${filtre} ORDER BY f.date_emission DESC, f.numero DESC LIMIT $3 OFFSET $4`,
        [statut, organisation, limite, page ? (page - 1) * PAR_PAGE : 0]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM facture f ${filtre}`, [statut, organisation]),
    ]);
    res.set('X-Total-Count', String(total));
    res.json(rows.map(factureAdmin));
  } catch (err) { next(err); }
});

const corpsEmission = z.object({
  contratId: z.uuid({ message: 'contratId invalide' }),
  periodeDebut: z.iso.date({ message: 'periodeDebut attendue au format AAAA-MM-JJ' }),
  periodeFin: z.iso.date({ message: 'periodeFin attendue au format AAAA-MM-JJ' }),
}).strict();

// POST /admin/factures/emettre { contratId, periodeDebut, periodeFin } — émission manuelle d'une période,
// y compris une période annulée par avoir (le job automatique, lui, ne la refacture jamais)
router.post('/emettre', requireCubi('super_admin'), async (req, res, next) => {
  try {
    const parsed = corpsEmission.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ message: parsed.error.issues[0].message });
    const r = await factures.emettreFacture(parsed.data);
    if (r.dejaEmise) {
      return res.status(409).json({
        error: `Une facture active existe déjà pour cette période (${r.facture.numero}). Émets d'abord un avoir pour la remplacer.`,
        factureId: r.facture.id,
      });
    }
    const { rows } = await pool.query(`${SELECT_VUE} WHERE f.id = $1`, [r.facture.id]);
    res.status(201).json(factureDetail(rows[0]));
  } catch (err) { repondreErreur(res, next, err); }
});

// GET /admin/factures/:id — détail, avec les avoirs émis sur la facture
router.get('/:id', idValide, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${SELECT_VUE} WHERE f.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    const { rows: avoirs } = await pool.query(
      `${SELECT_VUE} WHERE f.facture_origine_id = $1 ORDER BY f.date_emission, f.numero`, [req.params.id]
    );
    res.json({ ...factureDetail(rows[0]), avoirs: avoirs.map(factureAdmin) });
  } catch (err) { next(err); }
});

// GET /admin/factures/:id/pdf
router.get('/:id/pdf', idValide, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT numero, document_id FROM facture WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    const doc = await documentStorage.get(pool, rows[0].document_id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${rows[0].numero}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(doc.contenu);
  } catch (err) { next(err); }
});

const corpsPaiement = z.object({ datePaiement: z.iso.date({ message: 'datePaiement attendue au format AAAA-MM-JJ' }) });

// POST /admin/factures/:id/payer { datePaiement } — seuls statut et date_paiement changent (trigger)
router.post('/:id/payer', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const parsed = corpsPaiement.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ message: parsed.error.issues[0].message });
    const { datePaiement } = parsed.data;
    if (datePaiement > new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())) {
      return res.status(422).json({ message: 'La date de paiement ne peut pas être dans le futur.' });
    }
    const acteur = await acteurCubi(pool, req.auth.userId);
    const facture = await factures.marquerPayee(req.params.id, datePaiement, acteur);
    const { rows } = await pool.query(`${SELECT_VUE} WHERE f.id = $1`, [facture.id]);
    res.json(factureAdmin(rows[0]));
  } catch (err) { repondreErreur(res, next, err); }
});

const corpsAvoir = z.object({
  motif: z.string().trim().min(3, 'Le motif de l\'avoir est obligatoire.').max(300),
  lignes: z.array(z.object({
    label: z.string().trim().min(2).max(200),
    quantite: z.number().int().positive().max(100000).optional(),
    prixUnitaireHtCentimes: z.number().int().positive().max(100000000),
    tauxTva: z.number().min(0).max(100).optional(),
  })).min(1).max(50).optional(),
}).strict();

// POST /admin/factures/:id/avoir { motif, lignes? } — total si lignes absent, partiel sinon
router.post('/:id/avoir', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const parsed = corpsAvoir.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ message: parsed.error.issues[0].message });
    const acteur = await acteurCubi(pool, req.auth.userId);
    const avoir = await factures.emettreAvoir(req.params.id, parsed.data.motif, parsed.data.lignes || null, acteur);
    const { rows } = await pool.query(`${SELECT_VUE} WHERE f.id = $1`, [avoir.id]);
    res.json(factureDetail(rows[0]));
  } catch (err) { repondreErreur(res, next, err); }
});

// POST /admin/factures/:id/renvoyer — renvoie l'e-mail avec le PDF
router.post('/:id/renvoyer', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const ok = await factures.envoyerFactureParEmail(req.params.id);
    if (!ok) return res.status(502).json({ error: "L'e-mail n'a pas pu être envoyé. Réessaie dans un instant." });
    res.json({ message: 'Facture renvoyée' });
  } catch (err) { repondreErreur(res, next, err); }
});

module.exports = router;
