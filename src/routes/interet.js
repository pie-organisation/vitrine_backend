// POST /interet : formulaire « Je suis intéressé » de la landing page (public, sans compte).
// Rien n'est créé en base : les super-admins Cubi reçoivent le contact par e-mail et
// recontactent le prospect. Rate-limité et protégé par un champ piège contre les robots.

const router = require('express').Router();
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const { notifierAdmins } = require('../email');

const TYPES = {
  centre_formation: 'Centre de formation',
  ecole:            'École / enseignement supérieur',
  entreprise:       'Entreprise',
  autre:            'Autre',
};

const TAILLES = ['1-20', '21-100', '101-500', '500+'];

const corps = z.object({
  nom:          z.string().trim().min(1).max(120),
  email:        z.string().trim().email().max(200),
  organisation: z.string().trim().min(1).max(200),
  type:         z.enum(Object.keys(TYPES)),
  taille:       z.enum(TAILLES).optional(),
  telephone:    z.string().trim().max(30).optional(),
  message:      z.string().trim().max(2000).optional(),
  // Champ piège : invisible pour un humain, rempli par les robots
  site_web:     z.string().optional(),
});

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.appEnv === 'test',
  message: { error: 'Trop de demandes. Réessayez dans quelques minutes.' },
}));

router.post('/', async (req, res, next) => {
  try {
    const parsed = corps.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ message: 'Vérifiez les champs du formulaire (nom, e-mail, organisation et type sont requis).' });
    }
    const d = parsed.data;
    // Robot : on répond comme si tout allait bien, sans rien envoyer
    if (d.site_web) return res.json({ message: 'Merci, nous revenons vers vous très vite.' });

    const lignes = [
      `Nom : ${d.nom}`,
      `E-mail : ${d.email}`,
      d.telephone && `Téléphone : ${d.telephone}`,
      `Organisation : ${d.organisation}`,
      `Type : ${TYPES[d.type]}`,
      d.taille && `Nombre d'utilisateurs : ${d.taille}`,
      d.message && `\nMessage :\n${d.message}`,
    ].filter(Boolean);

    await notifierAdmins(
      `Nouveau prospect : ${d.organisation} (${TYPES[d.type]})`,
      `Un visiteur du site est intéressé par CUBI.\n\n${lignes.join('\n')}\n\nÀ recontacter sous 48h.`
    );

    res.json({ message: 'Merci, nous revenons vers vous très vite.' });
  } catch (err) { next(err); }
});

module.exports = router;
