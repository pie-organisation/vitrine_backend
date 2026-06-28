use argon2::{password_hash::{rand_core::OsRng, SaltString}, Argon2, PasswordHasher};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    let database_url = std::env::var("DATABASE_URL")?;
    let pool = PgPoolOptions::new().connect(&database_url).await?;

    // Crée d'abord une école factice pour respecter la FK
    let ecole_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO ecole (nom_complet_ecole, siret, adresse, code_postal, ville, type_licence_id, mot_de_passe_hash, statut)
         SELECT 'École Test', '00000000000001', '1 rue Test', '75001', 'Paris', id, 'hash', 'actif'
         FROM type_licence LIMIT 1
         ON CONFLICT (siret) DO UPDATE SET nom_complet_ecole = EXCLUDED.nom_complet_ecole
         RETURNING id"
    )
    .fetch_one(&pool)
    .await?;

    // Hash du mot de passe admin123
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(b"admin123", &salt)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .to_string();

    // Insère l'utilisateur admin
    sqlx::query(
        "INSERT INTO utilisateur (ecole_id, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
         VALUES ($1, 'Admin', 'Test', 'admin@cubi.fr', $2, FALSE, 'admin', 'actif')
         ON CONFLICT (email) DO UPDATE SET mot_de_passe_hash = EXCLUDED.mot_de_passe_hash, mdp_temporaire = FALSE"
    )
    .bind(ecole_id)
    .bind(&hash)
    .execute(&pool)
    .await?;

    println!("Admin créé : admin@cubi.fr / admin123");
    Ok(())
}
