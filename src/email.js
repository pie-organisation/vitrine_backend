// Envoi d'e-mails transactionnels (API Brevo). Le contenu (liens de signature, codes OTP)
// n'est jamais loggé.

const config = require('./config');
const pool = require('./db');

// Transport 'memoire' (tests) : les e-mails sont empilés ici au lieu d'être envoyés
const boiteMemoire = [];

// to : [{ email, name? }] ; attachments : [{ name, content: Buffer }]
async function envoyerEmail({ to, subject, text, attachments = [] }) {
  if (config.emailTransport === 'memoire') {
    boiteMemoire.push({ to, subject, text, attachments });
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.brevoApiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Cubi', email: config.emailFrom },
      to,
      subject,
      textContent: text,
      ...(attachments.length && {
        attachment: attachments.map(a => ({ name: a.name, content: a.content.toString('base64') })),
      }),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API ${res.status}: ${body}`);
  }
}

// Notifie tous les super_admin actifs de l'équipe Cubi
async function notifierAdmins(subject, text, attachments = []) {
  const { rows } = await pool.query(
    "SELECT email, prenom FROM utilisateur_cubi WHERE role = 'super_admin' AND statut = 'actif'"
  );
  if (!rows.length) return;
  await envoyerEmail({ to: rows.map(r => ({ email: r.email, name: r.prenom })), subject, text, attachments });
}

const fmtDate = d => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });

// ── Onboarding (déplacés depuis routes/admin.js, envoyés à la signature du contrat) ──

async function sendDemandeAcceptedEmail(email, prenom, typeDemande, nbEtablissements = 0) {
  const loginUrl = `${config.frontendUrl}/login`;
  const textContent = typeDemande === 'ecole'
    ? `Bonjour ${prenom},\n\nBonne nouvelle : votre demande d'inscription a été validée par notre équipe.\n\nVous pouvez dès maintenant vous connecter avec l'email et le mot de passe que vous avez choisis lors de votre inscription :\n${loginUrl}\n\nL'équipe CUBI`
    : nbEtablissements > 0
      ? `Bonjour ${prenom},\n\nBonne nouvelle : la demande d'inscription de votre groupe a été validée par notre équipe.\n\nLes ${nbEtablissements} établissements ont été créés. Chaque responsable d'établissement a reçu un email pour définir son mot de passe et accéder à son espace CUBI.\n\nL'équipe CUBI`
      : `Bonjour ${prenom},\n\nBonne nouvelle : la demande d'inscription de votre groupe scolaire a été validée par notre équipe.\n\nNotre équipe revient vers vous prochainement pour la suite.\n\nL'équipe CUBI`;

  await envoyerEmail({
    to: [{ email, name: prenom }],
    subject: 'Votre demande d\'inscription CUBI a été acceptée',
    text: textContent,
  });
}

async function sendWelcomeEmail(email, prenom, tokenReset, frontendUrl) {
  const resetLink = `${frontendUrl}/reset-password?token=${tokenReset}`;
  await envoyerEmail({
    to: [{ email, name: prenom }],
    subject: 'Bienvenue sur Cubi - Vos identifiants',
    text: `Bonjour ${prenom},\n\nVotre compte CUBI a été créé par un administrateur.\n\nDéfinissez votre mot de passe en cliquant sur ce lien :\n${resetLink}\n\nCe lien est valable 48h.\n\nL'équipe CUBI`,
  });
}

// ── Signature du contrat ──

function lienSignature(token) {
  return `${config.frontendUrl}/signature/${token}`;
}

async function emailSignerContrat({ email, nom, numero, token, expireLe }) {
  await envoyerEmail({
    to: [{ email, name: nom }],
    subject: `Votre demande CUBI est acceptée : signez votre contrat ${numero}`,
    text:
      `Bonjour ${nom},\n\n` +
      `Bonne nouvelle : votre demande d'inscription a été acceptée par notre équipe.\n\n` +
      `Pour activer vos licences, il reste à signer votre contrat ${numero}. ` +
      `La signature se fait en ligne, en quelques minutes : vous recevrez un code de confirmation par e-mail.\n\n` +
      `${lienSignature(token)}\n\n` +
      `Ce lien est personnel et valable jusqu'au ${fmtDate(expireLe)}.\n\n` +
      `L'équipe CUBI`,
  });
}

async function emailRelanceSignature({ email, nom, numero, token, expireLe }) {
  await envoyerEmail({
    to: [{ email, name: nom }],
    subject: `Rappel : votre contrat CUBI ${numero} attend votre signature`,
    text:
      `Bonjour ${nom},\n\n` +
      `Votre contrat ${numero} n'est pas encore signé. Vos licences seront activées dès la signature.\n\n` +
      `${lienSignature(token)}\n\n` +
      `Ce nouveau lien remplace les précédents et reste valable jusqu'au ${fmtDate(expireLe)}.\n\n` +
      `L'équipe CUBI`,
  });
}

async function emailCodeOtp({ email, nom, numero, otp }) {
  await envoyerEmail({
    to: [{ email, name: nom }],
    subject: `Votre code de signature CUBI : ${otp}`,
    text:
      `Bonjour ${nom},\n\n` +
      `Voici votre code pour signer le contrat ${numero} : ${otp}\n\n` +
      `Il est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.\n\n` +
      `L'équipe CUBI`,
  });
}

async function emailContratSigne({ email, nom, numero, preuveId, pdf }) {
  await envoyerEmail({
    to: [{ email, name: nom }],
    subject: `Contrat CUBI ${numero} signé`,
    text:
      `Bonjour ${nom},\n\n` +
      `Votre contrat ${numero} est signé. Vous le trouverez en pièce jointe, avec son certificat de signature ` +
      `(référence de preuve ${preuveId}).\n\n` +
      `Vos accès CUBI vous sont envoyés dans un e-mail séparé.\n\n` +
      `L'équipe CUBI`,
    attachments: [{ name: `${numero}-signe.pdf`, content: pdf }],
  });
}

// ── Facturation ──

const euros = c => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);

async function emailFacture({ email, nom, numero, avoir, totalTtcCentimes, dateEcheance, pdf }) {
  const texte = avoir
    ? `Vous trouverez en pièce jointe l'avoir ${numero} d'un montant de ${euros(-totalTtcCentimes)} TTC.`
    : `Vous trouverez en pièce jointe la facture ${numero} d'un montant de ${euros(totalTtcCentimes)} TTC, ` +
      `payable par virement au plus tard le ${fmtDate(dateEcheance)}. Merci d'indiquer ${numero} en référence du virement.`;
  await envoyerEmail({
    to: [{ email, name: nom }],
    subject: `${avoir ? 'Avoir' : 'Facture'} CUBI ${numero}`,
    text: `Bonjour,\n\n${texte}\n\nL'équipe CUBI`,
    attachments: [{ name: `${numero}.pdf`, content: pdf }],
  });
}

module.exports = {
  emailFacture,
  envoyerEmail, notifierAdmins, boiteMemoire,
  sendDemandeAcceptedEmail, sendWelcomeEmail,
  emailSignerContrat, emailRelanceSignature, emailCodeOtp, emailContratSigne,
};
