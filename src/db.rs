use anyhow::Result;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

/// Crée et retourne le pool de connexions PostgreSQL
pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .min_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(database_url)
        .await?;

    // Vérification de la connexion au démarrage
    sqlx::query("SELECT 1").execute(&pool).await?;
    tracing::info!("Connexion PostgreSQL établie");

    Ok(pool)
}
