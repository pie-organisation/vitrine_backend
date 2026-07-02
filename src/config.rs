use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub jwt_expiration_hours: u64,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub app_env: String,
    pub app_port: u16,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Config {
            database_url: required("DATABASE_URL")?,
            jwt_secret: required("JWT_SECRET")?,
            jwt_expiration_hours: required("JWT_EXPIRATION_HOURS")?
                .parse()
                .context("JWT_EXPIRATION_HOURS doit être un entier")?,
            smtp_host: required("SMTP_HOST")?,
            smtp_port: required("SMTP_PORT")?
                .parse()
                .context("SMTP_PORT doit être un entier")?,
            smtp_user: required("SMTP_USER")?,
            smtp_password: required("SMTP_PASSWORD")?,
            app_env: std::env::var("APP_ENV").unwrap_or_else(|_| "development".to_string()),
            // Render injecte PORT, fallback sur APP_PORT puis 3000
            app_port: std::env::var("PORT")
                .or_else(|_| std::env::var("APP_PORT"))
                .unwrap_or_else(|_| "3000".to_string())
                .parse()
                .context("PORT doit être un entier")?,
        })
    }
}

fn required(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("Variable d'environnement manquante : {key}"))
}
