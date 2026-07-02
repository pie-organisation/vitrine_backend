# Cubi Backend

API REST du projet **Cubi** — gestion des licences, sessions et utilisateurs pour établissements scolaires.

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Langage | Rust (édition 2021) |
| Framework HTTP | [Axum](https://github.com/tokio-rs/axum) 0.7 |
| Runtime async | Tokio |
| Base de données | PostgreSQL via [SQLx](https://github.com/launchbadge/sqlx) 0.8 |
| Hébergement BDD | [Neon](https://neon.tech) (serverless PostgreSQL) |
| Authentification | JWT ([jsonwebtoken](https://github.com/Keats/jsonwebtoken) 9) |
| Hachage mot de passe | Argon2 |
| Email | [Lettre](https://github.com/lettre/lettre) |
| Logs | Tracing + tracing-subscriber |
| Middleware | Tower / Tower-HTTP (CORS, trace HTTP) |
| Config | Dotenvy |
| Gestion d'erreurs | Thiserror + Anyhow |

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
| POST | `/auth/login` | Authentification, retourne un JWT |
| POST | `/auth/reset-password` | Réinitialisation via token temporaire |

### Protégées (JWT requis)
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/sessions/open` | Ouvrir une session |
| POST | `/sessions/close` | Fermer une session |
| GET | `/licences` | Lister les licences |
| PATCH | `/licences/:id/assign` | Assigner une licence |
| PATCH | `/licences/:id/unassign` | Désassigner une licence |

### Admin (JWT + rôle admin)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/admin/dashboard` | Tableau de bord |
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
APP_ENV=development
APP_PORT=3000
```

> ⚠️ Ne jamais commiter `.env` — il est dans `.gitignore`.

## Lancer le projet

**Prérequis :** Rust installé ([rustup.rs](https://rustup.rs))

```bash
cargo run
```

Les migrations sont appliquées automatiquement au démarrage :

```
INFO Connexion PostgreSQL établie
INFO Migrations appliquées
INFO Serveur Cubi démarré sur le port 3000
```

## Migrations

```bash
# Ajouter une migration
sqlx migrate add <nom>

# Appliquer manuellement
sqlx migrate run
```

Installer sqlx-cli (optionnel) :

```bash
cargo install sqlx-cli --no-default-features --features rustls,postgres
```
