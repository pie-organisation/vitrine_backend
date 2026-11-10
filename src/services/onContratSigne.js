// Activation de l'organisation une fois le contrat signé. Idempotent : l'événement
// 'organisation_activee', écrit dans la même transaction, marque le travail comme fait.
// Appelé après la signature, rejoué par le job quotidien et par POST /admin/contrats/:id/activer.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { avecTransaction, erreur } = require('./transaction');
const { evenement } = require('./contrats');
const { isoDate } = require('../pdf/mappers');
const { generateTempJwt } = require('../middleware/auth');
const { sendDemandeAcceptedEmail, sendWelcomeEmail, notifierAdmins } = require('../email');
const { facturerPeriodesDues, dateEffet } = require('./factures');

// Compte créé, ou déjà là pour cette école (rejeu) ; sinon l'e-mail appartient à une autre école
async function creerCompteAdmin(client, { ecoleId, nom, prenom, email, hash, mdpTemporaire }) {
  const { rows } = await client.query(
    `INSERT INTO utilisateur (id, ecole_id, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin', 'actif')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [crypto.randomUUID(), ecoleId, nom, prenom, email, hash, mdpTemporaire]
  );
  if (rows.length) return { cree: true, userId: rows[0].id };
  const { rows: existant } = await client.query('SELECT id, ecole_id FROM utilisateur WHERE email = $1', [email]);
  return { cree: false, userId: existant[0]?.id, conflit: existant[0]?.ecole_id !== ecoleId };
}

// Un seul contact par adresse (UNIQUE sur toute la table) : on récupère l'existant en cas de conflit
async function contactFacturation(client, { ecoleId, groupeId, nom, prenom, email }) {
  const { rows } = await client.query(
    `INSERT INTO contact_facturation (ecole_id, groupe_scolaire_id, nom_contact, prenom_contact, email_facturation)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email_facturation) DO NOTHING
     RETURNING id`,
    [ecoleId, groupeId, nom, prenom, email]
  );
  if (rows.length) return { id: rows[0].id, existant: false };
  const { rows: existant } = await client.query(
    'SELECT id, ecole_id, groupe_scolaire_id FROM contact_facturation WHERE email_facturation = $1', [email]
  );
  const c = existant[0];
  return { id: c.id, existant: true, autreOrganisation: c.ecole_id !== ecoleId || c.groupe_scolaire_id !== groupeId };
}

async function onContratSigne(contratId) {
  // Mot de passe aléatoire jamais communiqué : les responsables de groupe définissent le leur via l'invitation.
  // Haché hors transaction (bcrypt est lent) et partagé par les comptes créés dans cet appel.
  const hashProvisoire = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 12);

  const resultat = await avecTransaction(async client => {
    const { rows: [contrat] } = await client.query('SELECT * FROM contrat WHERE id = $1 FOR UPDATE', [contratId]);
    if (!contrat) throw erreur(404, 'Contrat introuvable');
    if (contrat.statut !== 'signe') throw erreur(409, `Contrat ${contrat.numero} non signé : activation impossible.`);

    const { rows: dejaFait } = await client.query(
      "SELECT 1 FROM contrat_evenement WHERE contrat_id = $1 AND type = 'organisation_activee' LIMIT 1", [contratId]
    );
    if (dejaFait.length) return null;

    const { rows: [demande] } = await client.query(
      'SELECT * FROM demande_inscription WHERE id = $1', [contrat.demande_inscription_id]
    );
    if (!demande) throw erreur(409, `Contrat ${contrat.numero} : demande d'inscription introuvable, comptes non créables.`);

    const { donnees } = contrat;
    const ecoleIds = donnees.etablissements.map(e => e.ecoleId);
    const groupeId = contrat.groupe_scolaire_id;

    // 1. Organisation active
    if (groupeId) {
      await client.query(
        "UPDATE groupe_scolaire SET statut = 'actif', date_modification = NOW() WHERE id = $1", [groupeId]
      );
    }
    await client.query("UPDATE ecole SET statut = 'actif' WHERE id = ANY($1::uuid[])", [ecoleIds]);

    // 2. Une ligne licence par licence, école par école, à partir de la date d'effet
    for (const e of donnees.etablissements) {
      await client.query(
        `INSERT INTO licence (ecole_id, type_licence_id, statut, date_debut)
         SELECT $1::uuid, $2::uuid, 'disponible', $3::date FROM generate_series(1, $4::int)`,
        [e.ecoleId, donnees.palier.typeLicenceId, isoDate(contrat.date_effet), e.quantite]
      );
    }

    // 3. Comptes admin (logique reprise de l'ancienne validation de demande)
    const invitations = [];
    const conflits = [];
    let comptesCrees = 0;
    if (demande.type_demande === 'ecole') {
      // Le mot de passe choisi à l'inscription devient celui du compte admin
      const r = await creerCompteAdmin(client, {
        ecoleId: ecoleIds[0], nom: demande.nom_contact, prenom: demande.prenom_contact,
        email: demande.email, hash: demande.mot_de_passe_hash, mdpTemporaire: false,
      });
      if (r.cree) comptesCrees++;
      if (r.conflit) conflits.push(demande.email);
    } else {
      const ecoleParSiret = new Map(donnees.etablissements.map(e => [e.siret, e.ecoleId]));
      for (const e of demande.etablissements || []) {
        const ecoleId = ecoleParSiret.get(e.siret);
        if (!ecoleId) continue;
        const r = await creerCompteAdmin(client, {
          ecoleId, nom: e.nom_responsable, prenom: e.prenom_responsable,
          email: e.email_responsable, hash: hashProvisoire, mdpTemporaire: true,
        });
        if (r.cree) {
          comptesCrees++;
          invitations.push({ ...e, userId: r.userId, ecoleId });
        }
        if (r.conflit) conflits.push(e.email_responsable);
      }
    }

    // 4. Contact de facturation : l'école, ou le groupe (un seul contact pour tout le groupe)
    const contact = await contactFacturation(client, {
      ecoleId: groupeId ? null : ecoleIds[0],
      groupeId,
      nom: demande.nom_contact || demande.nom_daf,
      prenom: demande.prenom_contact || demande.prenom_daf,
      email: demande.email,
    });

    // 5. Première facture : émise après le COMMIT (sa propre transaction, voir plus bas)

    await evenement(client, contratId, 'organisation_activee', {
      meta: {
        licences: donnees.quantiteTotale,
        comptesCrees,
        conflitsEmail: conflits,
        contactFacturationId: contact.id,
        contactFacturationAutreOrganisation: Boolean(contact.autreOrganisation),
      },
    });

    return { contrat, demande, invitations, conflits, contact };
  });

  if (!resultat) return { dejaActive: true };
  const { contrat, demande, invitations, conflits, contact } = resultat;

  // E-mails après COMMIT (mêmes e-mails qu'avant, désormais envoyés à la signature)
  try {
    await sendDemandeAcceptedEmail(
      demande.email, demande.prenom_contact || demande.prenom_daf, demande.type_demande, invitations.length
    );
  } catch (e) {
    console.warn(`Échec envoi email d'acceptation (contrat ${contrat.numero}) : ${e.message}`);
  }
  for (const inv of invitations) {
    try {
      const token = generateTempJwt({ id: inv.userId, ecole_id: inv.ecoleId, role: 'admin' }, 'ecole');
      await sendWelcomeEmail(inv.email_responsable, inv.prenom_responsable, token, config.frontendUrl);
    } catch (e) {
      console.warn(`Échec envoi invitation (contrat ${contrat.numero}) : ${e.message}`);
    }
  }

  if (conflits.length || contact.autreOrganisation) {
    const lignes = [
      ...conflits.map(email => `- ${email} : un compte existe déjà dans une autre organisation, compte non créé.`),
      ...(contact.autreOrganisation
        ? [`- ${demande.email} est déjà le contact de facturation d'une autre organisation : contact existant conservé.`]
        : []),
    ];
    await notifierAdmins(
      `Contrat ${contrat.numero} : activation à vérifier`,
      `L'organisation du contrat ${contrat.numero} est active, mais :\n${lignes.join('\n')}`
    ).catch(e => console.warn(`Notification admin non envoyée : ${e.message}`));
  }

  // Première facture, proratisée à partir de la date d'effet.
  // Idempotent ; en cas d'échec, le job quotidien facture le mois en cours au prochain passage.
  let factures = [];
  try {
    factures = await facturerPeriodesDues(contrat.id, dateEffet(contrat));
  } catch (e) {
    console.error(`Première facture non émise (contrat ${contrat.numero}) : ${e.message}`);
    await notifierAdmins(
      `Contrat ${contrat.numero} : première facture non émise`,
      `L'organisation est active mais la première facture n'a pas pu être émise : ${e.message}\n` +
      'Le job quotidien facturera le mois en cours ; vérifie les mois précédents éventuels.'
    ).catch(() => {});
  }

  return {
    dejaActive: false,
    invitations: invitations.length,
    conflits,
    factures: factures.map(f => f.facture.numero),
  };
}

module.exports = { onContratSigne };
