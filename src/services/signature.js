// Signature électronique simple (eIDAS art. 25) côté signataire : lien unique par e-mail + OTP.
// Toute erreur liée au token est générique : on ne révèle jamais si un token a existé.

const config = require('../config');
const pool = require('../db');
const documentStorage = require('./documentStorage');
const { avecTransaction, erreur } = require('./transaction');
const { evenement, evenements } = require('./contrats');
const { onContratSigne } = require('./onContratSigne');
const {
  sha256, hashToken, formatTokenValide, genererOtp, hashOtp, verifierOtp,
  validerSignaturePng, masquerEmail, genererPreuveId,
} = require('./signatureCrypto');
const { renderContratPdf } = require('../pdf/render');
const { isoDate } = require('../pdf/mappers');
const { emailCodeOtp, emailContratSigne, notifierAdmins } = require('../email');

const OTP_ESSAIS_MAX = 5;
const MENTION = 'Lu et approuvé';

const lienInvalide = () => erreur(404, 'Ce lien de signature est invalide ou a expiré.');

function urlVerification(preuveId) {
  return `${config.frontendUrl}/signature/verifier/${preuveId}`;
}

// Demande + contrat associés au token, ou null. `verrou` : FOR UPDATE sur les deux lignes.
async function charger(db, token, { verrou = false } = {}) {
  if (!formatTokenValide(token)) return null;
  const { rows } = await db.query(
    `SELECT d.id, d.contrat_id, d.statut, d.expire_le, d.otp_hash, d.otp_tentatives, d.preuve_id, d.date_fin,
            d.expire_le > NOW()                                   AS non_expiree,
            d.otp_expire_le IS NOT NULL AND d.otp_expire_le > NOW() AS otp_valide
     FROM demande_signature d
     WHERE d.token_hash = $1
     ${verrou ? 'FOR UPDATE' : ''}`,
    [hashToken(token)]
  );
  if (!rows.length) return null;
  const demande = rows[0];
  const { rows: contrats } = await db.query(
    `SELECT * FROM contrat WHERE id = $1 ${verrou ? 'FOR UPDATE' : ''}`, [demande.contrat_id]
  );
  return { demande, contrat: contrats[0] };
}

// Lien utilisable pour signer : demande ouverte, non expirée, contrat envoyé
function estSignable({ demande, contrat }) {
  return demande.statut === 'ouverte' && demande.non_expiree && contrat.statut === 'envoye';
}

// Lien d'un contrat déjà signé par ce token : affichage de la confirmation uniquement
function estSigne({ demande, contrat }) {
  return demande.statut === 'terminee' && contrat.statut === 'signe';
}

// ── GET /signature/:token ─────────────────────────────────────────────────────

async function consulter(token, { ip, userAgent }) {
  const ctx = await charger(pool, token);
  if (!ctx || !(estSignable(ctx) || estSigne(ctx))) throw lienInvalide();
  const { demande, contrat } = ctx;

  if (estSignable(ctx)) {
    // 'consulte' au plus une fois toutes les 10 minutes par contrat
    const { rows } = await pool.query(
      `SELECT 1 FROM contrat_evenement
       WHERE contrat_id = $1 AND type = 'consulte' AND horodatage > NOW() - INTERVAL '10 minutes' LIMIT 1`,
      [contrat.id]
    );
    if (!rows.length) {
      await evenement(pool, contrat.id, 'consulte', { acteur: contrat.signataire_email, ip, userAgent });
    }
  }

  return {
    statut: estSigne(ctx) ? 'signe' : 'a_signer',
    contrat: {
      numero: contrat.numero,
      offre: contrat.donnees.offre.nom,
      dateDebut: isoDate(contrat.date_debut),
      dureeMois: contrat.duree_mois,
    },
    organisation: contrat.donnees.client.name,
    signataire: {
      nom: contrat.signataire_nom,
      fonction: contrat.signataire_fonction,
      emailMasque: masquerEmail(contrat.signataire_email),
    },
    expireLe: demande.expire_le,
    ...(estSigne(ctx) && { preuveId: demande.preuve_id, dateSignature: contrat.date_signature_client }),
  };
}

// ── GET /signature/:token/pdf : original tant que c'est à signer, signé ensuite ──

async function pdf(token) {
  const ctx = await charger(pool, token);
  if (!ctx || !(estSignable(ctx) || estSigne(ctx))) throw lienInvalide();
  const docId = estSigne(ctx) ? ctx.contrat.document_signe_id : ctx.contrat.document_original_id;
  const doc = await documentStorage.get(pool, docId);
  return { numero: ctx.contrat.numero, contenu: doc.contenu, signe: estSigne(ctx) };
}

// ── POST /signature/:token/otp ────────────────────────────────────────────────
// Code valide 10 min, un envoi par minute au plus. L'e-mail part avant le COMMIT.

async function envoyerOtp(token, { ip, userAgent }) {
  if (!formatTokenValide(token)) throw lienInvalide();
  return avecTransaction(async client => {
    const ctx = await charger(client, token, { verrou: true });
    if (!ctx || !estSignable(ctx)) throw lienInvalide();
    const { demande, contrat } = ctx;

    const otp = genererOtp();
    const { rowCount } = await client.query(
      `UPDATE demande_signature SET otp_hash = $2, otp_expire_le = NOW() + INTERVAL '10 minutes'
       WHERE id = $1 AND (otp_expire_le IS NULL OR otp_expire_le <= NOW() + INTERVAL '9 minutes')`,
      [demande.id, hashOtp(otp, demande.id, config.jwtSecret)]
    );
    if (!rowCount) throw erreur(429, 'Un code vient d\'être envoyé. Patientez une minute avant d\'en demander un autre.');

    await evenement(client, contrat.id, 'otp_envoye', { ip, userAgent });
    await emailCodeOtp({ email: contrat.signataire_email, nom: contrat.signataire_nom, numero: contrat.numero, otp })
      .catch(() => { throw erreur(502, 'Le code n\'a pas pu être envoyé. Réessayez dans un instant.'); });

    return { message: `Code envoyé à ${masquerEmail(contrat.signataire_email)}`, expireDansSecondes: 600 };
  });
}

// ── POST /signature/:token/signer ─────────────────────────────────────────────

async function signer(token, { otp, signaturePng, mention, ip, userAgent }) {
  if (!formatTokenValide(token)) throw lienInvalide();
  // Image validée avant tout : une image refusée ne consomme pas d'essai OTP
  const { png } = (() => {
    try { return validerSignaturePng(signaturePng); } catch (e) { throw erreur(422, e.message); }
  })();
  if (mention.trim() !== MENTION) throw erreur(422, `La mention doit être « ${MENTION} ».`);

  // Les échecs (mauvais OTP, révocation, document altéré) sont enregistrés : la transaction
  // est validée puis l'erreur levée après le COMMIT.
  const resultat = await avecTransaction(async client => {
    const ctx = await charger(client, token, { verrou: true });
    if (!ctx) throw lienInvalide();
    if (estSigne(ctx)) throw erreur(409, 'Ce contrat est déjà signé.');
    if (!estSignable(ctx)) throw lienInvalide();
    const { demande, contrat } = ctx;

    if (!demande.otp_valide) throw erreur(422, 'Code expiré ou non demandé : demandez un nouveau code.');

    if (!verifierOtp(otp, demande.otp_hash, demande.id, config.jwtSecret)) {
      const tentatives = demande.otp_tentatives + 1;
      await client.query('UPDATE demande_signature SET otp_tentatives = $2 WHERE id = $1', [demande.id, tentatives]);
      await evenement(client, contrat.id, 'otp_echec', {
        acteur: contrat.signataire_email, ip, userAgent, meta: { tentative: tentatives },
      });
      if (tentatives >= OTP_ESSAIS_MAX) {
        await client.query(
          "UPDATE demande_signature SET statut = 'revoquee', date_fin = NOW() WHERE id = $1", [demande.id]
        );
        await evenement(client, contrat.id, 'revoque', { meta: { motif: 'otp_essais_max' } });
        return {
          echec: erreur(403, 'Trop de codes erronés : ce lien est désactivé. L\'équipe Cubi va vous recontacter.'),
          alerte: `Contrat ${contrat.numero} : ${OTP_ESSAIS_MAX} codes erronés, lien de signature révoqué. Renvoie le contrat depuis l'admin si la demande est légitime.`,
        };
      }
      return {
        echec: erreur(422, `Code incorrect. Il vous reste ${OTP_ESSAIS_MAX - tentatives} essai(s).`,
          { essaisRestants: OTP_ESSAIS_MAX - tentatives }),
      };
    }

    // Intégrité : le PDF présenté au signataire est bien celui figé à l'envoi
    const original = await documentStorage.get(client, contrat.document_original_id);
    if (!original || sha256(original.contenu) !== contrat.sha256_original || original.sha256 !== contrat.sha256_original) {
      await evenement(client, contrat.id, 'integrite_ko', { meta: { attendu: contrat.sha256_original } });
      return {
        echec: erreur(500, 'Le contrat ne peut pas être signé pour le moment. L\'équipe Cubi a été prévenue.'),
        alerte: `Contrat ${contrat.numero} : l'empreinte du PDF original ne correspond plus à sha256_original. Signature bloquée.`,
      };
    }

    const preuveId = genererPreuveId();
    const { rows: [{ maintenant }] } = await client.query('SELECT clock_timestamp() AS maintenant');
    await client.query(
      `UPDATE demande_signature SET statut = 'terminee', signature_png = $2, mention = $3, ip = $4,
         user_agent = $5, preuve_id = $6, date_fin = $7, otp_hash = NULL
       WHERE id = $1`,
      [demande.id, png, MENTION, ip, userAgent, preuveId, maintenant]
    );
    await evenement(client, contrat.id, 'signe', {
      acteur: contrat.signataire_email, ip, userAgent,
      meta: { preuveId, mention: MENTION, sha256Original: contrat.sha256_original },
    });

    // PDF signé : signatures + annexe certificat (empreinte d'origine et journal complet)
    const pdfSigne = await renderContratPdf(contrat, {
      signature: { png, signedAt: maintenant, mention: MENTION, proofId: preuveId },
      preuve: { evenements: await evenements(client, contrat.id), verifyUrl: urlVerification(preuveId) },
    });
    const doc = await documentStorage.put(client, { type: 'contrat_signe', contenu: pdfSigne });
    // date_effet : licences et facturation démarrent au plus tôt le jour de la signature (heure de Paris).
    // date_debut, imprimée dans le contrat signé, ne change pas.
    await client.query(
      `UPDATE contrat SET statut = 'signe', document_signe_id = $2, sha256_signe = $3,
         date_signature_client = $4, date_modification = NOW(),
         date_effet = GREATEST(date_debut, ($4::timestamptz AT TIME ZONE 'Europe/Paris')::date)
       WHERE id = $1`,
      [contrat.id, doc.id, doc.sha256, maintenant]
    );
    return { contrat, preuveId, pdfSigne };
  });

  if (resultat.alerte) {
    await notifierAdmins('Alerte signature de contrat CUBI', resultat.alerte)
      .catch(e => console.warn(`Notification admin non envoyée : ${e.message}`));
  }
  if (resultat.echec) throw resultat.echec;

  const { contrat, preuveId, pdfSigne } = resultat;
  await emailContratSigne({
    email: contrat.signataire_email, nom: contrat.signataire_nom, numero: contrat.numero, preuveId, pdf: pdfSigne,
  }).catch(e => console.warn(`E-mail de confirmation non envoyé (contrat ${contrat.numero}) : ${e.message}`));
  await notifierAdmins(
    `Contrat ${contrat.numero} signé`,
    `Le contrat ${contrat.numero} (${contrat.donnees.client.name}) a été signé par ${contrat.signataire_nom}.\nRéférence de preuve : ${preuveId}`,
    [{ name: `${contrat.numero}-signe.pdf`, content: pdfSigne }]
  ).catch(e => console.warn(`Notification admin non envoyée : ${e.message}`));

  // Le job quotidien rattrape l'activation si elle échoue ici
  await onContratSigne(contrat.id)
    .catch(e => console.error(`Activation après signature en échec (contrat ${contrat.numero}) : ${e.message}`));

  return { message: 'Contrat signé', numero: contrat.numero, preuveId };
}

// ── GET /signature/verifier/:preuveId ─────────────────────────────────────────

async function verifier(preuveId) {
  if (!/^SIG-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(preuveId)) return null;
  const { rows } = await pool.query(
    `SELECT c.numero, c.date_signature_client, c.sha256_original, c.sha256_signe
     FROM demande_signature d JOIN contrat c ON c.id = d.contrat_id
     WHERE d.preuve_id = $1 AND d.statut = 'terminee' AND c.statut = 'signe'`,
    [preuveId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    preuveId,
    numero: r.numero,
    dateSignature: r.date_signature_client,
    sha256Original: r.sha256_original,
    sha256Signe: r.sha256_signe,
  };
}

module.exports = { consulter, pdf, envoyerOtp, signer, verifier, MENTION, OTP_ESSAIS_MAX };
