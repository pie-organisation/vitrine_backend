mod config;
mod db;
mod error;
mod middleware;
mod models;
mod routes;
mod state;

use axum::{
    middleware as axum_middleware,
    routing::{delete, get, patch, post},
    Router,
};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use argon2::{password_hash::{rand_core::OsRng, SaltString}, Argon2, PasswordHasher};
use middleware::{auth::require_admin, auth::require_auth, session_guard::no_active_session};
use routes::{admin, auth, licences, school, sessions, users};
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = config::Config::from_env()?;
    let pool = db::create_pool(&config.database_url).await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("Migrations appliquées");

    seed_admin_if_missing(&pool).await?;

    let app_port = config.app_port;
    let app_state = AppState::new(pool, config);
    let app = build_router(app_state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{app_port}")).await?;
    tracing::info!("Serveur Cubi démarré sur le port {app_port}");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn seed_admin_if_missing(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    // Toujours récupère ou crée l'école par défaut
    let ecole_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO ecole (nom_complet_ecole, siret, adresse, code_postal, ville, type_licence_id, mot_de_passe_hash, statut)
         SELECT 'CUBI Admin', '00000000000001', '1 rue CUBI', '75001', 'Paris', id, 'n/a', 'actif'
         FROM type_licence ORDER BY sessions_min LIMIT 1
         ON CONFLICT (siret) DO UPDATE SET nom_complet_ecole = EXCLUDED.nom_complet_ecole
         RETURNING id",
    )
    .fetch_one(pool)
    .await?;

    // Génère un hash Rust natif — toujours mis à jour au démarrage
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(b"admin123", &salt)
        .map_err(|e| anyhow::anyhow!("Hash erreur: {e}"))?
        .to_string();

    // ON CONFLICT met à jour le hash même si l'admin existe déjà
    sqlx::query(
        "INSERT INTO utilisateur (ecole_id, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
         VALUES ($1, 'Admin', 'CUBI', 'admin@cubi.fr', $2, FALSE, 'admin', 'actif')
         ON CONFLICT (email) DO UPDATE
           SET mot_de_passe_hash = EXCLUDED.mot_de_passe_hash,
               mdp_temporaire    = FALSE,
               statut            = 'actif'",
    )
    .bind(ecole_id)
    .bind(&hash)
    .execute(pool)
    .await?;

    tracing::info!("Admin prêt : admin@cubi.fr / admin123");
    Ok(())
}

fn build_router(app_state: AppState) -> Router {
    let jwt_secret = app_state.config.jwt_secret.clone();
    let pool = app_state.pool.clone();

    // ── Routes publiques (sans auth) ──────────────────────────────────────────
    let public_routes = Router::new()
        .route("/auth/login",        post(auth::login))
        .route("/auth/inscription",  post(auth::inscription))
        .route("/auth/reset-password", post(auth::reset_password));

    // ── Routes protégées (JWT requis) ─────────────────────────────────────────
    let session_open = Router::new()
        .route("/sessions/open", post(sessions::open_session))
        .layer(axum_middleware::from_fn_with_state(pool.clone(), no_active_session));

    let protected_routes = Router::new()
        .merge(session_open)
        .route("/me",                      get(users::me))
        .route("/sessions/close",          post(sessions::close_session))
        .route("/licences",                get(licences::list_licences))
        .route("/licences/:id/assign",     patch(licences::assign_licence))
        .route("/licences/:id/unassign",   patch(licences::unassign_licence))
        // School routes
        .route("/school/organisation",     get(school::get_organisation))
        .route("/school/comptes",          get(school::list_comptes))
        .route("/school/comptes",          post(school::create_compte))
        .route("/school/comptes/:id",      patch(school::update_compte))
        .route("/school/comptes/:id",      delete(school::delete_compte))
        .route("/school/factures",         get(school::list_factures))
        .route("/school/activite",         get(school::list_activite))
        .route("/school/contact",          get(school::get_contact))
        .route("/school/contact",          patch(school::update_contact))
        .layer(axum_middleware::from_fn_with_state(jwt_secret.clone(), require_auth));

    // ── Routes admin (JWT + rôle admin) ──────────────────────────────────────
    let admin_routes = Router::new()
        .route("/admin/dashboard",             get(admin::dashboard))
        .route("/admin/metriques",             get(admin::metriques))
        .route("/admin/alertes",               get(admin::alertes))
        .route("/admin/analytiques",           get(admin::analytiques))
        // Organisations
        .route("/admin/organisations",         get(admin::list_organisations))
        .route("/admin/organisations/:id",     get(admin::get_organisation))
        // Plans
        .route("/admin/plans",                 get(admin::list_plans))
        .route("/admin/plans",                 post(admin::create_plan))
        .route("/admin/plans/:id",             patch(admin::update_plan))
        .route("/admin/plans/:id",             delete(admin::delete_plan))
        // Demandes d'inscription
        .route("/admin/demandes",              get(admin::list_demandes))
        .route("/admin/demandes/:id",          patch(admin::update_demande))
        // Sessions
        .route("/admin/sessions",              get(admin::list_sessions))
        .route("/admin/sessions/:id",          delete(admin::terminate_session))
        // Factures
        .route("/admin/factures",              get(admin::list_factures))
        // Journaux
        .route("/admin/journaux",              get(admin::list_journaux))
        // Équipe
        .route("/admin/equipe",                get(admin::list_equipe))
        .route("/admin/equipe",                post(admin::invite_equipe))
        .route("/admin/equipe/:id",            patch(admin::update_equipe))
        .route("/admin/equipe/:id",            delete(admin::delete_equipe))
        // Messages
        .route("/admin/messages",              get(admin::list_messages))
        .route("/admin/messages/:id",          patch(admin::update_message))
        // Offres
        .route("/admin/offres",                get(admin::list_offres))
        .route("/admin/offres",                post(admin::create_offre))
        .route("/admin/offres/:id",            patch(admin::update_offre))
        // Utilisateurs
        .route("/admin/users",                 post(users::create_user))
        .route("/admin/users",                 get(users::list_users))
        .route("/admin/users/:id/suspend",     delete(users::suspend_user))
        .layer(axum_middleware::from_fn(require_admin))
        .layer(axum_middleware::from_fn_with_state(jwt_secret, require_auth));

    Router::new()
        .merge(public_routes)
        .merge(protected_routes)
        .merge(admin_routes)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(app_state)
}
