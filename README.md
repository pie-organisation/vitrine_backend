# Cubi Backend

API REST du projet **Cubi** — gestion des licences, sessions et utilisateurs pour établissements scolaires.

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Langage | Node.js |
| Framework HTTP | [Express](https://expressjs.com) 4 |
| Base de données | PostgreSQL via [node-postgres (pg)](https://node-postgres.com) |
| Hébergement BDD | [Neon](https://neon.tech) (serverless PostgreSQL) |
| Authentification | JWT ([jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)) |
| Hachage mot de passe | Argon2 |
| Email | [Nodemailer](https://nodemailer.com) |
| CORS | cors |
| Config | dotenv |

## Architecture BDD

10 tables PostgreSQL dans l'ordre des dépendances :

```
type_licence
    └── groupe_scolaire
    └── ecole
            └── contact_facturation
            └── classe
                    └── utilisateur
                            └── licence
                                    └── session
                                            └── log_activite
demande_inscription
```

## Routes API

### Publiques
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/auth/inscription` | Soumettre une demande d'inscription |
| POST | `/auth/login` | Authentification, retourne un JWT |
| POST | `/auth/reset-password` | Réinitialisation via token temporaire |

### Protégées (JWT requis)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/me` | Profil de l'utilisateur connecté |
| POST | `/sessions/open` | Ouvrir une session |
| POST | `/sessions/close` | Fermer une session |
| GET | `/licences` | Lister les licences |
| PATCH | `/licences/:id/assign` | Assigner une licence |
| PATCH | `/licences/:id/unassign` | Désassigner une licence |
| GET | `/school/organisation` | Infos de l'école |
| GET | `/school/comptes` | Lister les comptes |
| POST | `/school/comptes` | Créer un compte |
| PATCH | `/school/comptes/:id` | Modifier un compte |
| DELETE | `/school/comptes/:id` | Suspendre un compte |
| GET | `/school/factures` | Factures |
| GET | `/school/activite` | Journal d'activité |
| GET | `/school/contact` | Contact de facturation |
| PATCH | `/school/contact` | Mettre à jour le contact |

### Admin (JWT + rôle admin)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/admin/dashboard` | Tableau de bord |
| GET | `/admin/metriques` | Métriques globales |
| GET | `/admin/alertes` | Alertes système |
| GET | `/admin/analytiques` | Analytiques |
| GET | `/admin/organisations` | Lister les organisations |
| GET | `/admin/organisations/:id` | Détail d'une organisation |
| GET | `/admin/plans` | Lister les plans (type_licence) |
| GET | `/admin/demandes` | Demandes d'inscription |
| PATCH | `/admin/demandes/:id` | Valider / rejeter une demande |
| GET | `/admin/sessions` | Toutes les sessions |
| DELETE | `/admin/sessions/:id` | Terminer une session |
| GET | `/admin/journaux` | Journaux d'activité |
| POST | `/admin/users` | Créer un utilisateur |
| GET | `/admin/users` | Lister les utilisateurs |
| DELETE | `/admin/users/:id/suspend` | Suspendre un utilisateur |

## Configuration (`.env`)

La base de données est hébergée sur **Neon** — toute l'équipe se connecte à la même instance, pas besoin d'installer PostgreSQL en local.

```bash
cp .env.example .env
```

Récupère la `DATABASE_URL` sur le canal privé de l'équipe (Discord) :

```
DATABASE_URL=postgresql://<user>:<password>@<host>.neon.tech/<db>?sslmode=require&channel_binding=require
JWT_SECRET=<secret>
JWT_EXPIRATION_HOURS=24
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
FRONT_URL=http://localhost:5173
APP_ENV=development
APP_PORT=3000
```

> ⚠️ Ne jamais commiter `.env` — il est dans `.gitignore`.

## Lancer le projet

**Prérequis :** Node.js 18+

```bash
npm install
npm run dev     # développement (nodemon, rechargement auto)
npm start       # production
```

Les migrations sont appliquées automatiquement au démarrage. Si le schéma existe déjà (base Neon déjà initialisée), il est détecté et les migrations ne sont pas rejouées.

```
Migrations appliquées
Admin prêt : admin@cubi.fr / admin123
Serveur Cubi démarré sur le port 3000
```

## Migrations

Les fichiers SQL sont dans `migrations/`. Ils sont exécutés automatiquement au démarrage via `src/migrate.js`.

Pour ajouter une migration, créer un nouveau fichier numéroté dans `migrations/` :

```
migrations/
  001_init.sql
  002_ma_migration.sql   ← nouveau fichier
```

## Documents PDF (factures, contrats)

Rendu HTML → PDF A4 via Chromium headless ([Puppeteer](https://pptr.dev)), dans `src/pdf/` :

| Fichier | Rôle |
|---------|------|
| `templates/*.hbs`, `templates/cubi-print.css` | Templates Handlebars (DA Cubi validée : ne pas redesigner) |
| `render.js` | `renderFacturePdf(facture)` et `renderContratPdf(contrat, { signature, preuve })` → `Buffer` |
| `mappers.js` | Lignes des tables `facture` / `contrat` → données des templates (forme de `reference/sample-data.json`) |
| `emetteur.js` | Mentions légales de Cubi, lues depuis les variables `CUBI_*` (voir `.env.example`) |

- Un seul navigateur partagé (`chrome-headless-shell`, plus léger que Chrome complet), relancé s'il plante ; 2 rendus simultanés au plus (RAM Render). Mesure locale : environ 150 Mo pour Chromium en pointe, 110 Mo pour Node.
- JavaScript désactivé dans la page de rendu ; les données sont échappées par Handlebars.
- Polices embarquées en base64 et requêtes réseau bloquées pendant le rendu.
- Montants en centimes (helper `money`), dates en heure de Paris (`date`, `datetime`), horodatages de preuve en UTC (`iso`).

**Aperçu** : `npm run pdf:preview` génère `tmp-preview/facture.pdf` et `tmp-preview/contrat.pdf` depuis `reference/sample-data.json`.

**Chromium et Render** : `.puppeteerrc.cjs` place Chromium dans `.cache/puppeteer/` (dans le projet, ignoré par git) plutôt que dans `~/.cache`, qui n'est pas conservé entre le build et l'exécution sur Render. Le `buildCommand` de `render.yaml` lance en plus `npx puppeteer browsers install chrome-headless-shell`, au cas où le cache de build de Render sauterait le postinstall de Puppeteer.

Puppeteer est fixé en **24.43.1** : les versions 25+ exigent Node ≥ 22.12, le projet tourne en Node 20.

## Tests

```bash
npm test
```

Runner intégré `node:test`, aucune dépendance de test hormis `pdf-parse`.

- **Sans base** (toujours exécutés) : rendu PDF, primitives de signature (token, OTP, PNG, palier, masquage), calculs de facturation (prorata, arrondis, TVA, avoirs), routes publiques rejetées avant tout accès SQL, CORS, secret du job.
- **Sur base** : `test/migration-004.test.js`, `test/signature-integration.test.js` et `test/facturation-integration.test.js` ne tournent que si `TEST_DATABASE_URL` pointe vers une **base de test dédiée** (jamais la base partagée) ; sinon ils sont ignorés. Le test d'intégration applique la migration 004, crée ses propres données (SIRET et e-mails uniques) et les laisse en base : contrats et journal de preuve ne se suppriment pas (triggers).

## Facturation

Code : `src/services/calculFacture.js` (calculs purs), `src/services/factures.js` (émission, avoirs, paiement), `src/services/vueFacture.js` (format JSON du front).

### Règles

- **Terme à échoir, par mois civil, à partir de la date d'effet.** `contrat.date_effet` = max(`date_debut`, date de signature), fixée à la signature : `date_debut` reste celle imprimée dans le contrat signé. La première période va de la date d'effet à la fin de son mois, proratisée au jour près (jours facturés / jours du mois). Les licences démarrent aussi à la date d'effet.
- **Lignes** calculées depuis `contrat.donnees` (figées à la signature) : une par établissement pour un groupe. Total de ligne = quantité × prix mensuel du palier × prorata, **arrondi au centime ligne par ligne**. La TVA (20 %) est ventilée par taux sur la base HT de chaque taux.
- **Frais de mise en service** : une ligne sur la première facture uniquement, et seulement si `FRAIS_MISE_EN_SERVICE_CENTIMES` > 0 (défaut 0). Aucun autre montant n'est ajouté.
- **Émission** (une transaction) : numéro `FAC-AAAA-NNNN` sans trou, parties figées (`client_snapshot` avec le contact de facturation, `emetteur_snapshot`), PDF rendu et stocké avec son SHA-256. Réémettre une période déjà facturée renvoie la facture existante.
- **E-mail** au contact de facturation, avec le PDF, **après** le COMMIT : un échec d'envoi est loggé et journalisé (`facture_email_echec`), la facture reste valable.
- **Quand** : à l'activation qui suit la signature (première facture, plus les mois écoulés si la signature arrive après le mois de début), puis chaque jour par le job quotidien pour le mois en cours, pour les contrats signés dont l'organisation est `actif`. Une période déjà facturée, même annulée par avoir, n'est jamais re-facturée automatiquement.
- **Avoirs** `AV-AAAA-NNNN` (séquence distincte, montants négatifs, mêmes parties que la facture d'origine) :
  - total par défaut : reprend toutes les lignes en négatif et passe la facture en `annulee_par_avoir` ;
  - partiel avec `lignes` ; si les partiels soldent exactement la facture, elle passe aussi en `annulee_par_avoir` ;
  - le cumul des avoirs ne dépasse jamais le TTC de la facture ; un avoir total n'est possible que s'il n'existe pas déjà d'avoir partiel.
- **Immuabilité** : une facture émise ne change plus, sauf `statut` et `date_paiement` (trigger en base) ; toute correction passe par un avoir.

### Routes admin (lecture : tous les rôles Cubi ; écriture : `super_admin`)

| Méthode | Route | Body | Réponse |
|---------|-------|------|---------|
| GET | `/admin/factures?statut=&organisation=&page=` | — | `Facture[]` (tableau). Sans `page` : tout (1 000 max) ; avec `page` : 50 par page. Total dans l'en-tête `X-Total-Count`. `organisation` = id d'école ou de groupe (une école membre d'un groupe voit aussi les factures du groupe) |
| GET | `/admin/factures/:id` | — | `Facture` + `{ lignes, ventilationTva, client, emetteur, sha256, avoirs: Facture[] }` |
| GET | `/admin/factures/:id/pdf` | — | PDF inline |
| POST | `/admin/factures/:id/payer` | `{ datePaiement: 'YYYY-MM-DD' }` | `Facture`. 409 si la facture n'est pas en attente ; 422 si la date est future ou antérieure à l'émission |
| POST | `/admin/factures/:id/avoir` | `{ motif, lignes?: [{ label, quantite?, prixUnitaireHtCentimes, tauxTva? }] }` | l'avoir (`Facture` détaillée). 422 si le plafond est dépassé ; 409 si la facture est déjà annulée, ou pour un total après des partiels |
| POST | `/admin/factures/:id/renvoyer` | — | `{ message }` ; 502 si l'e-mail n'est pas parti |
| POST | `/admin/factures/emettre` | `{ contratId, periodeDebut, periodeFin }` (un mois civil au plus, à partir de la date d'effet) | 201 + la facture détaillée. Émission manuelle, y compris d'une période annulée par avoir ; 409 si une facture active existe déjà pour la période |

`Facture` (admin) garde la forme des mocks du front : `{ id, organisationId, organisation, plan, montant: '2 605,20 €', echeance: 'JJ/MM/AAAA', statut, reference }`, plus `type`, `statutFacture`, `dateEmission`, `dateEcheance`, `datePaiement`, `periodeDebut`, `periodeFin`, `totalHtCentimes`, `totalTvaCentimes`, `totalTtcCentimes`, `factureOrigineId`, `factureOrigine`, `contratNumero`, `contratId`.

`statut` (admin) : `payee`, `en_attente` (émise, échéance non dépassée), `impayee` (émise, échéance dépassée), et deux **nouvelles valeurs** : `annulee` (facture annulée par avoir) et `avoir` (l'avoir lui-même). Le filtre `?statut=` accepte ces cinq valeurs.

### Routes école (JWT admin d'établissement, lecture seule)

| Méthode | Route | Réponse |
|---------|-------|---------|
| GET | `/school/factures` | `SchoolInvoice[]` : factures et avoirs de l'école ou de son groupe |
| GET | `/school/factures/:id/pdf` | PDF inline ; 404 si la facture n'est pas rattachée à l'école |

`SchoolInvoice` garde la forme des mocks : `{ id, reference, date, echeance, montant, statut }`, plus les mêmes champs détaillés que côté admin.

`statut` (école) : `presentee` (payée), `en_cours` (émise, à régler), et deux **nouvelles valeurs** : `annulee` et `avoir`. `a_venir` n'est jamais renvoyé : aucune facture n'est émise à l'avance.

### Écarts avec le front actuel

Les pages `admin/Facturation.tsx` et `school/FacturationEcole.tsx` indexent un dictionnaire de libellés par `statut`. Les valeurs `annulee` et `avoir` n'y figurent pas : il faut les ajouter à `FactureStatut`, `InvoiceStatut`, `STATUT_BADGE` et `STATUT_META`, sinon l'affichage d'une facture annulée ou d'un avoir plante. Le bouton « Télécharger le PDF » de l'école doit appeler `GET /school/factures/:id/pdf` au lieu de générer un `.txt`.

## Contrats et signature électronique

Signature électronique **simple** au sens d'eIDAS (UE 910/2014, art. 25) : lien unique envoyé par e-mail + code à usage unique (OTP) envoyé au même e-mail, journal de preuve horodaté, empreintes SHA-256 du PDF avant et après signature.

**Pas de contrat signé = pas d'organisation active, pas de compte, pas de licence.**

### Cycle de vie

```
demande en_attente --(admin valide)--> ecole/groupe 'inactif' + contrat 'brouillon'
contrat brouillon  --(admin envoie)--> 'envoye' : PDF original figé (sha256_original), lien J+14 par e-mail
contrat envoye     --(signataire : OTP + signature)--> 'signe' : PDF signé + certificat (sha256_signe)
                     puis onContratSigne : organisation 'actif', licences, comptes admin + e-mails, contact de facturation
contrat envoye     --(J+14 sans signature, job)--> 'expire'  (renvoyable : nouveau lien J+14)
brouillon / envoye / expire --(admin)--> 'annule'
```

Le palier (`type_licence`) est **calculé** à partir de la quantité totale (pour un groupe : somme des établissements, même palier pour tous). Les prix sont figés en centimes dans `contrat.donnees`.

### Routes admin (JWT équipe Cubi ; écriture : `super_admin`)

| Méthode | Route | Body | Réponse |
|---------|-------|------|---------|
| PATCH | `/admin/demandes/:id` | `{ statut: 'validee' ou 'refusee', nbLicences?, etablissements?: [{ siret, quantite }] }` | `{ message, contrat: { id, numero } }`. Quantité : body, sinon `nb_licences_estime` de la demande ; 422 si absente |
| GET | `/admin/contrats?statut=&page=` | — | `{ items: Contrat[], page, parPage: 20, total }` |
| GET | `/admin/contrats/:id` | — | `Contrat` + `{ evenements[], demandesSignature[] }` |
| PATCH | `/admin/contrats/:id` | `{ signataire?: { nom?, fonction?, email? }, adresseClient?, quantites?: [{ ecoleId, quantite }], dateDebut?: 'YYYY-MM-DD', dureeMois? }` | `Contrat`. Brouillon uniquement (409 sinon) |
| POST | `/admin/contrats/:id/envoyer` | — | `{ message, expireLe }`. 422 si nom, fonction ou e-mail du signataire, ou adresse du client, manquant ; 502 si l'e-mail n'est pas parti (rien n'est enregistré) |
| POST | `/admin/contrats/:id/renvoyer` | — | `{ message, expireLe }`. Révoque le lien ouvert ; relance aussi un contrat expiré |
| POST | `/admin/contrats/:id/annuler` | — | `{ message }` |
| POST | `/admin/contrats/:id/activer` | — | `{ message, dejaActive, invitations, conflits }`. Rejoue l'activation post-signature (idempotent) |
| GET | `/admin/contrats/:id/pdf` | — | PDF inline : signé, sinon original, sinon aperçu non stocké (brouillon) |
| POST | `/admin/organisations/:id/suspendre` | — | `{ message }` |
| DELETE | `/admin/organisations/:id` | — | 409 `{ error, action: 'suspendre' }` dès qu'un contrat ou une facture existe (pièces à conserver 10 ans) |

`Contrat` : `{ id, numero, statut, organisation, type: 'ecole' | 'groupe', ecoleId, groupeId, offre, quantiteTotale, prixUnitaireCentimes, etablissements: [{ ecoleId, nom, siret, quantite, prixUnitaireCentimes }], dateDebut, dureeMois, signataire: { nom, fonction, email }, sha256Original, sha256Signe, dateSignatureCubi, dateSignatureClient, dateCreation, dateModification }`

La fonction du signataire n'est pas connue à l'inscription, ni l'adresse du siège d'un groupe : l'admin les saisit (PATCH) avant l'envoi.

**Connexion** : un compte d'établissement dont l'école (ou son groupe) n'est pas `actif` est refusé par `POST /auth/login` avec 403 `{ error: 'organisation_inactive', message }` (contrat non signé ou organisation suspendue), distinct du 401 « Identifiants invalides ». Le contrôle a lieu après la vérification du mot de passe. Un JWT déjà émis reste valable jusqu'à son expiration.

### Routes école (JWT admin d'établissement, lecture seule)

| Méthode | Route | Réponse |
|---------|-------|---------|
| GET | `/school/contrats` | `[{ id, numero, statut, offre, quantiteTotale, dateDebut, dureeMois, signataire, dateSignature, pdfDisponible }]` : contrats de l'école ou de son groupe (hors brouillons) |
| GET | `/school/contrats/:id/pdf` | PDF inline (signé, sinon original) ; 404 si le contrat n'est pas rattaché à l'école |

### Routes publiques de signature (token du lien, CORS limité à `FRONT_URL`, rate-limit)

Toute erreur liée au lien est **générique** : 404 `{ error: 'Ce lien de signature est invalide ou a expiré.' }`, que le token n'existe pas, soit expiré ou révoqué. Convention : `{ message }` pour les 422 (à afficher tel quel), `{ error }` sinon.

| Méthode | Route | Body | Réponse |
|---------|-------|------|---------|
| GET | `/signature/:token` | — | `{ statut: 'a_signer' ou 'signe', contrat: { numero, offre, dateDebut, dureeMois }, organisation, signataire: { nom, fonction, emailMasque }, expireLe, preuveId?, dateSignature? }` |
| GET | `/signature/:token/pdf` | — | PDF inline : original tant que `a_signer`, signé ensuite |
| POST | `/signature/:token/otp` | — | `{ message, expireDansSecondes: 600 }` ; 429 si un code a été envoyé il y a moins d'une minute |
| POST | `/signature/:token/signer` | `{ otp: '123456', signaturePng: 'data:image/png;base64,…', mention: 'Lu et approuvé', acceptation: true }` | `{ message, numero, preuveId }` ; 422 `{ message, essaisRestants }` si code faux ; 403 au 5e code faux (lien révoqué, admin prévenu) ; 409 si déjà signé ; 422 si code expiré ou non demandé, ou image refusée |
| GET | `/signature/verifier/:preuveId` | — | `{ preuveId, numero, dateSignature, sha256Original, sha256Signe }` : comparer `sha256Signe` au SHA-256 du PDF détenu |

Limites : 100 requêtes / 15 min / IP sur `/signature`, 10 / 15 min sur `otp` et `signer`. Image : PNG réel, 200 Ko max, 100 à 3000 px de large, 40 à 1500 px de haut.

### Page front `/signature/:token` (à construire)

1. **Chargement** : `GET /signature/:token`. 404 : écran « lien invalide ou expiré, contactez Cubi » (aucun détail). `statut: 'signe'` : aller directement à l'étape 6.
2. **Lecture** : en-tête (n° de contrat, organisation, signataire et e-mail masqué, date limite `expireLe`) et PDF affiché depuis `GET /signature/:token/pdf` (iframe ou object, avec un lien « Télécharger »).
3. **Acceptation** : case à cocher « J'ai lu le contrat et j'en accepte les conditions » (`acceptation: true`) et mention « Lu et approuvé » affichée, envoyée telle quelle.
4. **Signature** : pad de dessin (canvas d'environ 600 × 200, fond transparent), boutons « Effacer » et « Valider » ; export `canvas.toDataURL('image/png')`. Refuser côté front un pad vide.
5. **Code** : bouton « Recevoir mon code » vers `POST …/otp` (« Code envoyé à s***d@… », bouton de renvoi désactivé 60 s) ; champ 6 chiffres vers `POST …/signer`. Afficher le `message` des 422 et `essaisRestants` ; 403 : écran « lien désactivé ».
6. **Confirmation** : « Contrat signé », référence de preuve, lien de téléchargement du PDF signé (`GET …/pdf`). Le PDF signé est aussi envoyé par e-mail ; les accès arrivent dans un e-mail séparé.

Page optionnelle `/signature/verifier/:preuveId` (lien imprimé dans le certificat) : afficher le résultat de `GET /signature/verifier/:preuveId`.

### Relances et expiration : job quotidien

Render (offre gratuite) met le service en veille : pas de cron interne. Un cron externe appelle une fois par jour :

```bash
curl -X POST https://<api>/internal/jobs/quotidien -H "X-Job-Secret: $JOB_SECRET"
# { "expires": 0, "relances": 2, "activationsRattrapees": 0, "factures": 3, "erreurs": [] }
```

- **cron-job.org** : nouvelle tâche, méthode POST, URL ci-dessus, en-tête `X-Job-Secret`, tous les jours (par exemple 8 h, Europe/Paris). L'appel réveille le service s'il dort : prévoir un timeout de 60 s.
- **Render Cron Job** : service « Cron Job », planning `0 7 * * *` (UTC), commande : la même requête `curl`.

Le job est idempotent :
- expiration à J+14 : contrat `expire`, admin notifié ;
- relances à J+3 puis J+7 : le token n'étant stocké que haché, une relance envoie un **nouveau lien** à la même échéance et révoque l'ancien ;
- rattrapage des activations post-signature qui auraient échoué ;
- facturation du mois en cours (voir « Facturation »).

### Sécurité

- Token (32 octets aléatoires) et OTP jamais stockés ni loggés en clair : SHA-256 pour le token, HMAC-SHA256 (clé `JWT_SECRET`, liée à la demande) pour l'OTP ; comparaisons en temps constant.
- Le token est dans l'URL : il apparaît dans les logs d'accès de l'hébergeur (Render), pas dans ceux de l'application.
- Avant signature, le SHA-256 du PDF original stocké est recomparé à `sha256_original` ; en cas d'écart, la signature est bloquée (`integrite_ko`) et l'admin est prévenu.
