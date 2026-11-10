// /admin/contrats — monté dans routes/admin.js (requireAuth + équipe Cubi). Écriture : super_admin.
const router = require('express').Router();
const { z } = require('zod');
const pool = require('../db');
const { requireCubi } = require('../middleware/auth');
const messagerie = require('../messagerie');
const contrats = require('../services/contrats');
const { onContratSigne } = require('../services/onContratSigne');
const { isoDate } = require('../pdf/mappers');

const PAR_PAGE = 20;
const STATUTS = ['brouillon', 'envoye', 'signe', 'annule', 'expire'];

// Colonnes de contrat (aucune BYTEA) + nom de l'organisation
const SELECT_CONTRAT = `
  SELECT c.*, COALESCE(e.nom_complet_ecole, g.nom_du_siege) AS organisation
  FROM contrat c
  LEFT JOIN ecole e           ON e.id = c.ecole_id
  LEFT JOIN groupe_scolaire g ON g.id = c.groupe_scolaire_id`;

function serializeContrat(r) {
  return {
    id: r.id,
    numero: r.numero,
    statut: r.statut,
    organisation: r.organisation || r.donnees.client.name,
    type: r.groupe_scolaire_id ? 'groupe' : 'ecole',
    ecoleId: r.ecole_id,
    groupeId: r.groupe_scolaire_id,
    offre: r.donnees.offre.nom,
    quantiteTotale: r.donnees.quantiteTotale,
    prixUnitaireCentimes: r.donnees.palier.prixUnitaireCentimes,
    etablissements: r.donnees.etablissements,
    dateDebut: isoDate(r.date_debut),
    dateEffet: isoDate(r.date_effet),
    dureeMois: r.duree_mois,
    signataire: { nom: r.signataire_nom, fonction: r.signataire_fonction, email: r.signataire_email },
    sha256Original: r.sha256_original,
    sha256Signe: r.sha256_signe,
    dateSignatureCubi: r.date_signature_cubi,
    dateSignatureClient: r.date_signature_client,
    dateCreation: r.date_creation,
    dateModification: r.date_modification,
  };
}

function idValide(req, res, next) {
  if (!messagerie.isUuid(req.params.id)) return res.status(404).json({ error: 'Contrat introuvable' });
  next();
}

// Les erreurs métier ({ status, message }) suivent la convention : { message } en 422, { error } sinon
function repondreErreur(res, next, err) {
  if (err.status === 422) return res.status(422).json({ message: err.message });
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
}

// GET /admin/contrats?statut=…&page=…
router.get('/', async (req, res, next) => {
  try {
    const statut = STATUTS.includes(req.query.statut) ? req.query.statut : null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `${SELECT_CONTRAT} WHERE ($1::text IS NULL OR c.statut = $1)
         ORDER BY c.date_creation DESC LIMIT $2 OFFSET $3`,
        [statut, PAR_PAGE, (page - 1) * PAR_PAGE]
      ),
      pool.query('SELECT COUNT(*)::int AS total FROM contrat WHERE ($1::text IS NULL OR statut = $1)', [statut]),
    ]);
    res.json({ items: rows.map(serializeContrat), page, parPage: PAR_PAGE, total });
  } catch (err) { next(err); }
});

// GET /admin/contrats/:id — détail, journal et historique des envois
router.get('/:id', idValide, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${SELECT_CONTRAT} WHERE c.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Contrat introuvable' });
    const [evts, { rows: demandes }] = await Promise.all([
      contrats.evenements(pool, req.params.id),
      pool.query(
        `SELECT id, statut, expire_le, otp_tentatives, preuve_id, ip, date_creation, date_fin
         FROM demande_signature WHERE contrat_id = $1 ORDER BY date_creation DESC`,
        [req.params.id]
      ),
    ]);
    res.json({
      ...serializeContrat(rows[0]),
      evenements: evts.map(e => ({
        id: e.id, horodatage: e.horodatage, type: e.type, acteur: e.acteur, ip: e.ip, meta: e.meta,
      })),
      demandesSignature: demandes.map(d => ({
        id: d.id, statut: d.statut, expireLe: d.expire_le, otpTentatives: d.otp_tentatives,
        preuveId: d.preuve_id, ip: d.ip, dateCreation: d.date_creation, dateFin: d.date_fin,
      })),
    });
  } catch (err) { next(err); }
});

const corpsModification = z.object({
  signataire: z.object({
    nom: z.string().trim().min(2).max(200).optional(),
    fonction: z.string().trim().min(2).max(150).optional(),
    email: z.email().max(255).optional(),
  }).optional(),
  quantites: z.array(z.object({
    ecoleId: z.uuid(),
    quantite: z.number().int().positive().max(100000),
  })).min(1).optional(),
  adresseClient: z.string().trim().min(5).max(300).optional(),
  dateDebut: z.iso.date().optional(),
  dureeMois: z.number().int().min(1).max(60).optional(),
}).strict();

// PATCH /admin/contrats/:id — brouillon uniquement
router.patch('/:id', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const parsed = corpsModification.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ message: parsed.error.issues[0].message });
    const acteur = await contrats.acteurCubi(pool, req.auth.userId);
    const contrat = await contrats.modifierBrouillon(req.params.id, parsed.data, acteur);
    const { rows } = await pool.query(`${SELECT_CONTRAT} WHERE c.id = $1`, [contrat.id]);
    res.json(serializeContrat(rows[0]));
  } catch (err) { repondreErreur(res, next, err); }
});

// POST /admin/contrats/:id/envoyer — PDF original figé + lien de signature par e-mail
router.post('/:id/envoyer', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const acteur = await contrats.acteurCubi(pool, req.auth.userId);
    const r = await contrats.envoyer(req.params.id, acteur);
    res.json({ message: `Contrat ${r.numero} envoyé pour signature`, expireLe: r.expireLe });
  } catch (err) { repondreErreur(res, next, err); }
});

// POST /admin/contrats/:id/renvoyer — révoque le lien ouvert, en envoie un nouveau (J+14)
router.post('/:id/renvoyer', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const acteur = await contrats.acteurCubi(pool, req.auth.userId);
    const r = await contrats.renvoyer(req.params.id, acteur);
    res.json({ message: `Nouveau lien de signature envoyé pour le contrat ${r.numero}`, expireLe: r.expireLe });
  } catch (err) { repondreErreur(res, next, err); }
});

// POST /admin/contrats/:id/annuler
router.post('/:id/annuler', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const acteur = await contrats.acteurCubi(pool, req.auth.userId);
    const r = await contrats.annuler(req.params.id, acteur);
    res.json({ message: `Contrat ${r.numero} annulé` });
  } catch (err) { repondreErreur(res, next, err); }
});

// POST /admin/contrats/:id/activer — relance l'activation post-signature (idempotent)
router.post('/:id/activer', idValide, requireCubi('super_admin'), async (req, res, next) => {
  try {
    const r = await onContratSigne(req.params.id);
    res.json({ message: r.dejaActive ? 'Organisation déjà activée' : 'Organisation activée', ...r });
  } catch (err) { repondreErreur(res, next, err); }
});

// GET /admin/contrats/:id/pdf — signé s'il existe, sinon l'original ; aperçu non stocké en brouillon
router.get('/:id/pdf', idValide, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contrat WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Contrat introuvable' });
    const { contenu, apercu, signe } = await contrats.pdfDuContrat(rows[0]);
    const suffixe = signe ? '-signe' : apercu ? '-apercu' : '';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${rows[0].numero}${suffixe}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(contenu);
  } catch (err) { next(err); }
});

module.exports = router;
