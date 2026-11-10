# PDF factures/contrats et signature électronique de contrat

Branche `feat/documents-signature`, partie de `main`.

**Règle métier introduite : pas de contrat signé = pas d'organisation active, pas de compte, pas de licence, pas de facture.**

## Flux

```
 Demande d'inscription (POST /auth/inscription, + nb_licences_estime optionnel)
        │
        ▼
 Validation admin (PATCH /admin/demandes/:id)                       aucun e-mail
   ├─ quantité confirmée ou corrigée, palier calculé
   ├─ école / groupe + écoles créés en 'inactif'
   └─ contrat 'brouillon' (CTR-AAAA-NNNN, données et prix figés en centimes)
        │  l'admin complète la fonction du signataire (et l'adresse du siège pour un groupe)
        ▼
 Envoi (POST /admin/contrats/:id/envoyer)
   ├─ PDF original rendu, stocké, sha256_original figé (+ contre-signature Cubi si configurée)
   ├─ contrat 'envoye', lien unique valable 14 jours (seul le SHA-256 du token est stocké)
   └─ e-mail « demande acceptée, signez votre contrat »
        │
        ▼
 Signature (page front /signature/:token)
   ├─ consultation du PDF, case d'acceptation, pad de signature
   ├─ code OTP par e-mail (10 min, 1/min, 5 essais par lien)
   ├─ intégrité : SHA-256 du PDF stocké = sha256_original
   └─ dans une transaction : preuve (IP, user-agent, preuve_id), PDF signé + certificat,
      contrat 'signe', date_effet = max(date_debut, jour de signature)
        │  e-mails : PDF signé au signataire et aux super_admin
        ▼
 onContratSigne (idempotent)
   ├─ école / groupe et ses écoles en 'actif'
   ├─ licences 'disponible' (une ligne par licence, école par école) à date_effet
   ├─ comptes admin + e-mails existants (« connectez-vous », invitations des responsables)
   ├─ contact de facturation (un seul pour un groupe)
   └─ première facture FAC-AAAA-NNNN, proratisée à partir de date_effet, PDF par e-mail
        │
        ▼
 Job quotidien (cron externe → POST /internal/jobs/quotidien, header X-Job-Secret)
   ├─ expiration à J+14 : demande 'expiree', contrat 'expire', admin notifié
   ├─ relances à J+3 et J+7 : nouveau lien (même échéance), ancien révoqué
   ├─ rattrapage des activations post-signature en échec
   └─ facture du mois en cours des contrats signés dont l'organisation est active
```

## Routes

### Ajoutées

| Route | Accès |
|-------|-------|
| `GET /admin/contrats`, `GET /admin/contrats/:id`, `GET /admin/contrats/:id/pdf` | équipe Cubi |
| `PATCH /admin/contrats/:id`, `POST /admin/contrats/:id/{envoyer,renvoyer,annuler,activer}` | super_admin |
| `GET /admin/factures/:id`, `GET /admin/factures/:id/pdf` | équipe Cubi |
| `POST /admin/factures/emettre`, `POST /admin/factures/:id/{payer,avoir,renvoyer}` | super_admin |
| `POST /admin/organisations/:id/suspendre` | super_admin |
| `GET /school/contrats`, `GET /school/contrats/:id/pdf`, `GET /school/factures/:id/pdf` | admin d'établissement |
| `GET /signature/:token`, `GET /signature/:token/pdf`, `POST /signature/:token/otp`, `POST /signature/:token/signer`, `GET /signature/verifier/:preuveId` | public (token), CORS `FRONT_URL`, rate-limit |
| `POST /internal/jobs/quotidien` | header `X-Job-Secret` |

### Modifiées

| Route | Changement |
|-------|------------|
| `POST /auth/inscription` | accepte `nb_licences_estime` (école) et `etablissements[].nb_licences_estime` (groupe), optionnels |
| `POST /auth/login` | **403 `{ error: 'organisation_inactive', message }`** si l'école ou son groupe n'est pas `actif` (contrat non signé, organisation suspendue). Contrôle fait après le mot de passe |
| `PATCH /admin/demandes/:id` | la validation exige une quantité (`nbLicences` ou `etablissements[].quantite`, sinon l'estimation de la demande) ; crée l'organisation **inactive** et un contrat brouillon ; **n'envoie plus aucun e-mail ni invitation** (tout part à la signature) ; refuse dès la validation un e-mail déjà pris |
| `GET /admin/demandes` | expose `nbLicencesEstime` (demande et établissements) |
| `GET /admin/factures`, `GET /school/factures` | renvoient les vraies factures au lieu de `[]`, dans la forme des mocks du front (tableaux), plus des champs détaillés |
| `DELETE /admin/organisations/:id` | **409 `{ error, action: 'suspendre' }`** dès qu'un contrat ou une facture existe (pièces à conserver 10 ans) |
| toutes les routes authentifiées | un jeton de réinitialisation de mot de passe (lien d'invitation) n'est plus accepté comme session |

Le détail des corps et réponses est dans le README (sections Facturation, Contrats et signature électronique).

## Variables d'environnement

| Variable | Statut | Exemple | Rôle |
|----------|--------|---------|------|
| `DATABASE_URL` | existante | `postgresql://…neon.tech/neondb?sslmode=require` | |
| `JWT_SECRET` | existante | `openssl rand -base64 48` | sert aussi de clé HMAC des codes OTP : la changer invalide les codes en cours (pas les liens) |
| `BREVO_API_KEY` | existante, absente de l'ancien `.env.example` | `xkeysib-…` | envoi des e-mails |
| `SMTP_FROM` | existante | `noreply@cubi.fr` | expéditeur des e-mails |
| `FRONT_URL` | **nouvelle** (`FRONTEND_URL` reste accepté) | `https://cubi.fr` (sans `/` final) | liens des e-mails, **seule origine CORS de `/signature`** |
| `JOB_SECRET` | **nouvelle** | `openssl rand -base64 32` | header `X-Job-Secret` du cron ; vide = job refusé (401) |
| `FRAIS_MISE_EN_SERVICE_CENTIMES` | **nouvelle** | `0` (ou `15000` pour 150 € HT) | ligne sur la première facture si > 0 |
| `CUBI_RAISON_SOCIALE` | **nouvelle** | `CUBI SAS` | mentions légales (factures, contrats) |
| `CUBI_FORME_JURIDIQUE` | **nouvelle** | `SAS` | |
| `CUBI_CAPITAL` | **nouvelle** | `10 000 €` | |
| `CUBI_ADRESSE` | **nouvelle** | `12 rue de la Paix, 75001 Paris` | |
| `CUBI_SIRET` | **nouvelle** | `123 456 789 00012` | |
| `CUBI_RCS` | **nouvelle** | `RCS Paris` | |
| `CUBI_TVA_INTRACOM` | **nouvelle** | `FR12 123456789` | |
| `CUBI_EMAIL_FACTURATION` | **nouvelle** | `facturation@cubi.fr` | |
| `CUBI_IBAN` | **nouvelle** | `FR76 3000 4000 5000 0000 0000 000` | |
| `CUBI_BIC` | **nouvelle** | `BNPAFRPPXXX` | |
| `CUBI_DELAI_PAIEMENT_JOURS` | **nouvelle** | `30` | échéance des factures |
| `CUBI_SIGNATAIRE_NOM` | **nouvelle** | `M. A. Durand` | représentant de Cubi sur les contrats |
| `CUBI_SIGNATAIRE_FONCTION` | **nouvelle** | `Président` | |
| `CUBI_SIGNATURE_PNG_BASE64` | **nouvelle**, optionnelle | sortie de `base64 -w0 signature.png` | contre-signature apposée à l'envoi ; absente = « En attente de contre-signature » |
| `EMAIL_TRANSPORT` | tests uniquement | ne pas définir en prod | `memoire` = aucun e-mail envoyé |
| `TEST_DATABASE_URL` | tests uniquement | jamais en prod | base de test dédiée |
| `APP_ENV` | existante | `production` | **ne jamais mettre `test` en prod : cela désactive le rate-limit** |

Une variable `CUBI_*` absente s'imprime « À COMPLÉTER » sur les documents : à vérifier avant la première vraie facture.

## Render

- `render.yaml` : `buildCommand` = `yarn install --frozen-lockfile && npx puppeteer browsers install chrome-headless-shell`. `.puppeteerrc.cjs` place Chromium dans `.cache/puppeteer` (dans le projet, conservé jusqu'au runtime). Les variables y sont listées en `sync: false` (valeurs saisies dans le dashboard).
- Puppeteer **24.43.1** (les 25.x exigent Node ≥ 22.12) lancé en `headless: 'shell'` : le binaire installé au build est bien celui utilisé.
- **RAM** (mesure locale, mémoire privée, 20 rendus du contrat signé, 2 en parallèle) : Node ≈ 70 Mo au repos, 110 Mo en pointe ; Chromium ≈ 70 Mo au repos, 150 Mo en pointe. Sous Linux, avec les bibliothèques partagées, compter **~300 à 350 Mo en pointe** : ça tient dans 512 Mo, avec ~150 Mo de marge.
- **CPU** : un rendu prend ~0,5 s en local. Sur l'offre gratuite (0,1 CPU), compter plusieurs secondes : la requête de signature rend le PDF signé dans la transaction, l'utilisateur attend. L'offre Starter (0,5 CPU, pas de mise en veille) est recommandée dès la mise en prod ; elle rend aussi le cron moins critique.
- Si Chromium ne démarre pas (bibliothèque système manquante dans l'environnement natif Render), passer le service en runtime Docker avec une image incluant les dépendances de Chrome.

## Checklist de mise en prod (dans l'ordre)

**a. Tester la migration dans Neon, sans rien appliquer.** Coller `scripts/verifier-migration.sql` dans le SQL Editor de Neon (ou `psql "$DATABASE_URL" -f scripts/verifier-migration.sql`). Attendu : le NOTICE « Migration 004 : toutes les vérifications passent », puis le récapitulatif des colonnes. Tout est annulé par le `ROLLBACK` final. Si l'éditeur n'accepte pas `BEGIN`/`ROLLBACK`, utiliser `psql`, ou une branche Neon jetable.

**b. Vérifier `_migrations`.**
```sql
SELECT filename FROM _migrations ORDER BY filename;
-- attendu : 001_init.sql, 002_messagerie.sql, 003_inscription_groupe.sql
```
⚠️ Si la table est **vide**, `src/migrate.js` marquerait **toutes** les migrations, 004 comprise, comme appliquées **sans les exécuter**. Dans ce cas, insérer d'abord les trois lignes :
```sql
INSERT INTO _migrations (filename) VALUES ('001_init.sql'), ('002_messagerie.sql'), ('003_inscription_groupe.sql');
```

**c. Variables d'env sur Render** : toutes celles du tableau ci-dessus, en particulier `FRONT_URL`, `JOB_SECRET`, `BREVO_API_KEY`, `SMTP_FROM` et les `CUBI_*`. Vérifier que `APP_ENV` ≠ `test`.

**d. Push** de la branche, puis merge.

**e. Logs de démarrage** : attendre `Migration appliquée : 004_documents_signature.sql`, `Migrations appliquées`, puis `Serveur Cubi démarré`. Au build : la ligne `chrome-headless-shell@… /opt/render/project/src/.cache/puppeteer/…`.

**f. Cron externe** : `POST https://<api>/internal/jobs/quotidien`, header `X-Job-Secret: <JOB_SECRET>`, une fois par jour (cron-job.org, ou Render Cron Job `0 7 * * *` + `curl`), timeout 60 s. Un appel manuel doit répondre `{ expires, relances, activationsRattrapees, factures, erreurs: [] }`.

**g. Test de bout en bout avec une fausse demande** :
1. Inscrire une école de test (e-mail que tu reçois, SIRET fictif) avec un nombre d'utilisateurs.
2. Admin : valider la demande. L'école est `inactif`, un contrat brouillon existe, aucun e-mail n'est parti.
3. `PATCH /admin/contrats/:id` (fonction du signataire), puis `GET …/pdf` pour l'aperçu, puis `POST …/envoyer`.
4. Ouvrir le lien reçu, demander le code, signer.
5. Vérifier : contrat `signe` ; e-mails (PDF signé, « connectez-vous », facture) ; connexion du compte école ; licences visibles ; facture dans `/school/factures` ; `GET /signature/verifier/<preuveId>` renvoie le SHA-256 du PDF reçu (`sha256sum`).
6. Nettoyage : contrats et factures ne se suppriment pas. Émettre un avoir total sur la facture de test et suspendre l'organisation (`POST /admin/organisations/:id/suspendre`).

## Tests

- `npm test` : 36 tests sans base, réussis ; 18 tests sur base, ignorés sans `TEST_DATABASE_URL`.
- **Les tests sur base n'ont jamais tourné** : avant le merge, les lancer une fois contre une branche Neon de test (`TEST_DATABASE_URL=… npm test`). Ils couvrent le parcours de signature complet, les 5 mauvais OTP, l'expiration, l'altération du PDF, l'isolation entre écoles, l'idempotence d'`onContratSigne` et du job, la numérotation concurrente et les avoirs.
- `npm run pdf:preview` : contrat non signé, contrat signé avec annexe, facture de groupe au prorata, avoir, dans `tmp-preview/`.
- `npm run migration:verifier` : régénère `scripts/verifier-migration.sql` après toute modification de la 004 (un test échoue s'il n'est pas à jour).

## Sécurité (revue finale)

- **Liens de signature** : token de 256 bits, seul son SHA-256 est stocké ; même réponse 404 pour un token inconnu, expiré ou révoqué ; format vérifié avant toute requête SQL. Rate-limit : 100 requêtes / 15 min / IP, 10 sur `otp` et `signer`.
- **OTP** : HMAC lié à la demande ; 5 essais par lien, cumulés sur les renvois de code ; la demande est verrouillée (`FOR UPDATE`) pendant la vérification, donc des requêtes parallèles ne contournent pas le compteur.
- **PNG** : relu entièrement avant le rendu (CRC, IHDR/IEND, rien après IEND, 8 bits non entrelacé, 2000 × 1000 px max), décompression bornée à la taille exacte attendue (pas de bombe), 200 Ko max.
- **Templates** : échappement Handlebars partout (`{{{ }}}` réservé à `css` et `fontFaces`, vérifié par un test), JavaScript désactivé et réseau bloqué dans la page de rendu.
- **IDOR** : les routes `/school/*` filtrent en SQL depuis le `ecole_id` du JWT. Un admin d'école membre d'un groupe voit les contrats et factures **du groupe**, lignes des autres écoles comprises (comportement demandé).
- **`/internal`** : 401 identique sans secret, avec un faux secret ou si `JOB_SECRET` n'est pas configuré ; rate-limit ; aucune erreur interne renvoyée.
- **Admin** : toutes les routes d'écriture exigent `super_admin`, sauf la messagerie (`support` autorisé, choix antérieur).

## Points restants

- **Front** : champ « nombre d'utilisateurs estimé » dans le formulaire d'inscription ; écrans admin des contrats (brouillon : signataire, adresse du siège, quantités, envoi) et des factures (paiement, avoir, émission manuelle).
- **Statuts côté front** : ajouter `annulee` et `avoir` à `FactureStatut`, `InvoiceStatut`, `STATUT_BADGE` et `STATUT_META` (sinon l'affichage plante) ; aligner `presentee` / `en_cours` ; brancher les téléchargements sur les routes PDF.
- **Page `/signature/:token`** (et `/signature/verifier/:preuveId`) : parcours décrit dans le README.
- **Résiliation** : fin de contrat, `licence.date_fin`, arrêt de la facturation, dernière facture au prorata.
- **Stockage S3 (hébergé en France)** : remplacer l'implémentation de `src/services/documentStorage.js` (put/get) ; les appelants ne changent pas.
- À surveiller :
  - un JWT déjà émis reste valable jusqu'à son expiration (24 h) après une suspension ;
  - les liens d'invitation émis avant ce déploiement restent utilisables comme session pendant leurs 48 h ;
  - sur un avoir, le pied de page garde « Paiement à N jours… Pas d'escompte » ;
  - la police du bloc méta extrait les tirets entre chiffres en U+2212 au copier-coller.

## Découpage en commits conseillé

Déjà sur la branche : `52334ce fix: aligner la contrainte statut de demande_inscription sur la prod` (`migrations/001_init.sql`).

Ne pas commiter `package-lock.json` (périmé, Render utilise yarn : à supprimer), ni `schema_neon.sql`, `.cache/`, `tmp-preview/` (ignorés).

1. **`chore: ignorer le schéma Neon, le cache Chromium et les aperçus PDF`**
   `.gitignore`

2. **`feat(db): migration 004 contrats, signature et factures`**
   `migrations/004_documents_signature.sql`, `src/services/numerotation.js`, `scripts/generer-verifier-migration.js`, `scripts/verifier-migration.sql`, `test/migration-004.test.js`

3. **`feat(pdf): rendu PDF des factures et contrats (Puppeteer)`**
   `src/pdf/` (templates, `render.js`, `mappers.js`, `emetteur.js`), `scripts/pdf-preview.js`, `reference/`, `.puppeteerrc.cjs`, `render.yaml`, `test/pdf.test.js`, `package.json`, `yarn.lock`
   (`package.json` et `yarn.lock` contiennent aussi `zod` et `express-rate-limit`, utilisés au commit 4 : sans conséquence)

4. **`feat(contrats): signature électronique du contrat et facturation`**
   `src/app.js`, `src/index.js`, `src/config.js`, `src/email.js`,
   `src/services/` (`transaction`, `documentStorage`, `signatureCrypto`, `palier`, `contrats`, `signature`, `onContratSigne`, `jobQuotidien`, `calculFacture`, `factures`, `vueFacture`),
   `src/routes/` (`signature`, `internal`, `adminContrats`, `adminFactures`, `admin`, `school`),
   `src/routes/auth.js` **partiellement** : `git add -p` sur les hunks `nb_licences_estime` uniquement,
   `test/signature-unitaire.test.js`, `test/signature-integration.test.js`, `test/facturation-unitaire.test.js`, `test/facturation-integration.test.js`
   (signature et facturation sont liées : `onContratSigne` émet la première facture et le job facture ; les séparer obligerait à découper les mêmes fichiers)

5. **`fix(auth): refuser la connexion d'une organisation inactive et les liens d'invitation comme session`**
   `src/routes/auth.js` (le hunk du login), `src/middleware/auth.js`, `test/signature-http.test.js`

6. **`docs: documentation des contrats, de la signature et de la facturation`**
   `README.md`, `.env.example`, `docs/PR_documents_signature.md`

`npm test` passe à chaque commit à partir du 3 (les scripts `test` et `migration:verifier` arrivent avec `package.json`) : les tests du login et des liens d'invitation n'entrent qu'au 5, avec le code qu'ils vérifient.
