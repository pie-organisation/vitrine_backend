use axum::extract::FromRef;
use sqlx::PgPool;

use crate::config::Config;

/// État global partagé entre tous les handlers via injection Axum
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Self {
        Self { pool, config }
    }
}

/// Permet aux handlers de n'extraire que le pool via State<PgPool>
impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

/// Permet aux handlers de n'extraire que la config via State<Config>
impl FromRef<AppState> for Config {
    fn from_ref(state: &AppState) -> Self {
        state.config.clone()
    }
}
