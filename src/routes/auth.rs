use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::password_hash::{rand_core::OsRng, SaltString};
use axum::{extract::State, Json};
use chrono::Utc;
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    config::Config,
    error::AppError,
    middleware::auth::Claims,
    models::utilisateur::Utilisateur,
};

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub mot_de_passe: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub user_id: Uuid,
    pub role: String,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    /// JWT temporaire reçu par email lors de la création du compte
    pub token_temporaire: String,
    pub nouveau_mot_de_passe: String,
}

#[derive(Serialize)]
pub struct ResetPasswordResponse {
    pub message: String,
}

// ── DTOs inscription ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct InscriptionRequest {
    /// "ecole" | "groupe"
    pub r#type: String,
    pub nom: String,
    pub email: String,
    pub mot_de_passe: Option<String>,
    pub siret: Option<String>,
    pub nom_daf: Option<String>,
    pub prenom_daf: Option<String>,
}

#[derive(Serialize)]
pub struct InscriptionResponse {
    pub message: String,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// POST /auth/inscription
/// Soumet une demande d'inscription (statut en_attente, traitée par un admin).
pub async fn inscription(
    State(pool): State<PgPool>,
    Json(body): Json<InscriptionRequest>,
) -> Result<Json<InscriptionResponse>, AppError> {
    // On utilise le premier type_licence disponible comme valeur par défaut
    let type_licence_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM type_licence WHERE actif = TRUE ORDER BY sessions_min LIMIT 1",
    )
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::InternalError(anyhow::anyhow!("Aucun type_licence disponible")))?;

    sqlx::query(
        r#"
        INSERT INTO demande_inscription
            (type_demande, nom_siege_ou_ecole, nom_daf, prenom_daf, siret, type_licence_id, statut)
        VALUES ($1, $2, $3, $4, $5, $6, 'en_attente')
        "#,
    )
    .bind(&body.r#type)
    .bind(&body.nom)
    .bind(&body.nom_daf)
    .bind(&body.prenom_daf)
    .bind(&body.siret)
    .bind(type_licence_id)
    .execute(&pool)
    .await?;

    tracing::info!(email = %body.email, "Demande d'inscription soumise");

    Ok(Json(InscriptionResponse {
        message: "Votre demande a été reçue. Un administrateur la traitera sous 48h.".to_string(),
    }))
}

/// POST /auth/login
/// Authentifie un utilisateur et retourne un JWT valide 24h.
/// Retourne 403 avec message "reset_required" si le mot de passe est temporaire.
pub async fn login(
    State(pool): State<PgPool>,
    State(config): State<Config>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    // Récupération de l'utilisateur par email (les mots de passe ne sont jamais loggés)
    let utilisateur = sqlx::query_as::<_, Utilisateur>(
        "SELECT * FROM utilisateur WHERE email = $1 AND statut = 'actif'",
    )
    .bind(&body.email)
    .fetch_optional(&pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    // Vérification du hash argon2
    let hash = PasswordHash::new(&utilisateur.mot_de_passe_hash)
        .map_err(|_| AppError::InternalError(anyhow::anyhow!("Hash invalide en base")))?;

    Argon2::default()
        .verify_password(body.mot_de_passe.as_bytes(), &hash)
        .map_err(|_| AppError::Unauthorized)?;

    // Mot de passe temporaire → l'utilisateur doit d'abord le réinitialiser
    if utilisateur.mdp_temporaire {
        return Err(AppError::Forbidden("reset_required".to_string()));
    }

    // Mise à jour de la date de dernière connexion
    sqlx::query("UPDATE utilisateur SET derniere_connexion = NOW() WHERE id = $1")
        .bind(utilisateur.id)
        .execute(&pool)
        .await?;

    let token = generate_jwt(&utilisateur, &config)?;

    tracing::info!(user_id = %utilisateur.id, "Connexion réussie");

    Ok(Json(LoginResponse {
        token,
        user_id: utilisateur.id,
        role: utilisateur.role,
    }))
}

/// POST /auth/reset-password
/// Réinitialise le mot de passe via un token temporaire (JWT à usage unique).
pub async fn reset_password(
    State(pool): State<PgPool>,
    State(config): State<Config>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<ResetPasswordResponse>, AppError> {
    // Vérification du token temporaire (même structure JWT que les tokens normaux)
    let claims = jsonwebtoken::decode::<Claims>(
        &body.token_temporaire,
        &jsonwebtoken::DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .map_err(|_| AppError::Unauthorized)?
    .claims;

    let user_id = claims.sub;

    // Hachage du nouveau mot de passe
    let salt = SaltString::generate(&mut OsRng);
    let nouveau_hash = Argon2::default()
        .hash_password(body.nouveau_mot_de_passe.as_bytes(), &salt)
        .map_err(|e| AppError::InternalError(anyhow::anyhow!("Erreur hachage : {e}")))?
        .to_string();

    // Mise à jour : hash + désactivation du flag temporaire
    let rows = sqlx::query(
        "UPDATE utilisateur
         SET mot_de_passe_hash = $1, mdp_temporaire = FALSE
         WHERE id = $2 AND mdp_temporaire = TRUE",
    )
    .bind(&nouveau_hash)
    .bind(user_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound(
            "Utilisateur introuvable ou mot de passe déjà réinitialisé".to_string(),
        ));
    }

    tracing::info!(user_id = %user_id, "Mot de passe réinitialisé");

    Ok(Json(ResetPasswordResponse {
        message: "Mot de passe mis à jour avec succès".to_string(),
    }))
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

pub fn generate_jwt(utilisateur: &Utilisateur, config: &Config) -> Result<String, AppError> {
    let exp = (Utc::now()
        + chrono::Duration::hours(config.jwt_expiration_hours as i64))
    .timestamp() as u64;

    let claims = Claims {
        sub: utilisateur.id,
        ecole_id: utilisateur.ecole_id,
        role: utilisateur.role.clone(),
        exp,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::InternalError(anyhow::anyhow!("Génération JWT : {e}")))
}

/// Génère un JWT temporaire (48h) pour l'email de réinitialisation de mot de passe
pub fn generate_temp_jwt(utilisateur: &Utilisateur, config: &Config) -> Result<String, AppError> {
    let exp = (Utc::now() + chrono::Duration::hours(48)).timestamp() as u64;

    let claims = Claims {
        sub: utilisateur.id,
        ecole_id: utilisateur.ecole_id,
        role: utilisateur.role.clone(),
        exp,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::InternalError(anyhow::anyhow!("Génération JWT temp : {e}")))
}
