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

use middleware::{auth::require_admin, auth::require_auth, session_guard::no_active_session};
use routes::{admin, auth, licences, sessions, users};
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Chargement du fichier .env (silencieux si absent en production)
    let _ = dotenvy::dotenv();

    // Initialisation des logs structurés avec filtre via RUST_LOG
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = config::Config::from_env()?;
    let pool = db::create_pool(&config.database_url).await?;

    // Application des migrations SQLx au démarrage
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("Migrations appliquées");

    let app_port = config.app_port;
    let app_state = AppState::new(pool, config);
    let app = build_router(app_state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{app_port}")).await?;
    tracing::info!("Serveur Cubi démarré sur le port {app_port}");

    axum::serve(listener, app).await?;
    Ok(())
}

fn build_router(app_state: AppState) -> Router {
    let jwt_secret = app_state.config.jwt_secret.clone();
    let pool = app_state.pool.clone();

    // Routes publiques : pas d'authentification requise
    let public_routes = Router::new()
        .route("/auth/login", post(auth::login))
        .route("/auth/reset-password", post(auth::reset_password));

    // Routes protégées : JWT obligatoire
    // session_guard (no_active_session) est appliqué uniquement sur /sessions/open
    let session_open = Router::new()
        .route("/sessions/open", post(sessions::open_session))
        .layer(axum_middleware::from_fn_with_state(
            pool.clone(),
            no_active_session,
        ));

    let protected_routes = Router::new()
        .merge(session_open)
        .route("/sessions/close", post(sessions::close_session))
        .route("/licences", get(licences::list_licences))
        .route("/licences/:id/assign", patch(licences::assign_licence))
        .route("/licences/:id/unassign", patch(licences::unassign_licence))
        // require_auth est la couche la plus externe → s'exécute en premier
        .layer(axum_middleware::from_fn_with_state(
            jwt_secret.clone(),
            require_auth,
        ));

    // Routes admin : JWT + vérification du rôle admin
    // Ordre d'exécution : require_auth → require_admin → handler
    let admin_routes = Router::new()
        .route("/admin/dashboard", get(admin::dashboard))
        .route("/admin/users", post(users::create_user))
        .route("/admin/users", get(users::list_users))
        .route("/admin/users/:id/suspend", delete(users::suspend_user))
        .layer(axum_middleware::from_fn(require_admin))
        .layer(axum_middleware::from_fn_with_state(
            jwt_secret,
            require_auth,
        ));

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
