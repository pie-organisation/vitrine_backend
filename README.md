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
FRONTEND_URL=http://localhost:5173
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
