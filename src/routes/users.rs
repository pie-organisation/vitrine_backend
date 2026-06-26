use argon2::{Argon2, PasswordHasher};
use argon2::password_hash::{rand_core::OsRng, SaltString};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use lettre::{
    message::header::ContentType, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    config::Config,
    error::AppError,
    middleware::auth::AuthUser,
    models::utilisateur::Utilisateur,
    routes::auth::generate_temp_jwt,
};

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub nom: String,
    pub prenom: String,
    pub email: String,
    pub role: String,
    pub classe_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct CreateUserResponse {
    pub utilisateur_id: Uuid,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// POST /admin/users
/// Crée un utilisateur avec un mot de passe temporaire et lui envoie les identifiants par email.
/// Réservé aux admins (garanti par le middleware require_admin).
pub async fn create_user(
    State(pool): State<PgPool>,
    State(config): State<Config>,
    Extension(auth_user): Extension<AuthUser>,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<CreateUserResponse>, AppError> {
    // Vérification que l'email n'est pas déjà utilisé
    let existe: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM utilisateur WHERE email = $1)",
    )
    .bind(&body.email)
    .fetch_one(&pool)
    .await?;

    if existe {
        return Err(AppError::Conflict(
            "Un utilisateur avec cet email existe déjà".to_string(),
        ));
    }

    // Génération d'un mot de passe temporaire aléatoire (12 caractères)
    let mot_de_passe_temp = generate_temp_password();
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(mot_de_passe_temp.as_bytes(), &salt)
        .map_err(|e| AppError::InternalError(anyhow::anyhow!("Erreur hachage : {e}")))?
        .to_string();

    let user_id = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO utilisateur (id, ecole_id, classe_id, invite_par, nom, prenom, email, mot_de_passe_hash, mdp_temporaire, role, statut)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, 'actif')
        "#,
    )
    .bind(user_id)
    .bind(auth_user.ecole_id)
    .bind(body.classe_id)
    .bind(auth_user.user_id)
    .bind(&body.nom)
    .bind(&body.prenom)
    .bind(&body.email)
    .bind(&hash)
    .bind(&body.role)
    .execute(&pool)
    .await?;

    // Génération du token temporaire inclus dans l'email (pour le reset-password)
    let utilisateur_tmp = Utilisateur {
        id: user_id,
        ecole_id: auth_user.ecole_id,
        classe_id: body.classe_id,
        invite_par: Some(auth_user.user_id),
        nom: body.nom.clone(),
        prenom: body.prenom.clone(),
        email: body.email.clone(),
        mot_de_passe_hash: String::new(),
        mdp_temporaire: true,
        role: body.role.clone(),
        statut: "actif".to_string(),
        date_invitation: chrono::Utc::now(),
        derniere_connexion: None,
    };
    let token_temp = generate_temp_jwt(&utilisateur_tmp, &config)?;

    // Envoi de l'email de bienvenue (ne bloque pas si l'envoi échoue en dev)
    if let Err(e) = send_welcome_email(&config, &body.email, &body.prenom, &mot_de_passe_temp, &token_temp).await {
        tracing::warn!("Échec envoi email de bienvenue pour {}: {e}", body.email);
    }

    tracing::info!(
        user_id = %user_id,
        created_by = %auth_user.user_id,
        "Utilisateur créé"
    );

    Ok(Json(CreateUserResponse {
        utilisateur_id: user_id,
    }))
}

/// GET /admin/users
/// Liste tous les utilisateurs de l'école.
pub async fn list_users(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
) -> Result<Json<Vec<Utilisateur>>, AppError> {
    let users = sqlx::query_as::<_, Utilisateur>(
        "SELECT * FROM utilisateur WHERE ecole_id = $1 ORDER BY date_invitation DESC",
    )
    .bind(auth_user.ecole_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(users))
}

/// DELETE /admin/users/:id/suspend
/// Suspend un utilisateur (soft delete, conserve l'historique).
pub async fn suspend_user(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = sqlx::query(
        "UPDATE utilisateur SET statut = 'suspendu' WHERE id = $1 AND ecole_id = $2",
    )
    .bind(user_id)
    .bind(auth_user.ecole_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound("Utilisateur introuvable".to_string()));
    }

    tracing::info!(user_id = %user_id, suspended_by = %auth_user.user_id, "Utilisateur suspendu");

    Ok(Json(serde_json::json!({ "message": "Utilisateur suspendu" })))
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

fn generate_temp_password() -> String {
    // Alphabet sans caractères ambigus (0/O, 1/l/I)
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

async fn send_welcome_email(
    config: &Config,
    email: &str,
    prenom: &str,
    mot_de_passe: &str,
    token_reset: &str,
) -> Result<(), AppError> {
    let body = format!(
        "Bonjour {prenom},\n\n\
         Votre compte Cubi a été créé.\n\n\
         Email : {email}\n\
         Mot de passe temporaire : {mot_de_passe}\n\n\
         Vous devez réinitialiser votre mot de passe lors de votre première connexion.\n\
         Token de réinitialisation (à fournir à POST /auth/reset-password) :\n\
         {token_reset}\n\n\
         L'équipe Cubi"
    );

    let message = Message::builder()
        .from(
            format!("Cubi <{}>", config.smtp_user)
                .parse()
                .map_err(|e| AppError::InternalError(anyhow::anyhow!("Email from invalide : {e}")))?,
        )
        .to(email
            .parse()
            .map_err(|e| AppError::InternalError(anyhow::anyhow!("Email destinataire invalide : {e}")))?)
        .subject("Bienvenue sur Cubi - Vos identifiants")
        .header(ContentType::TEXT_PLAIN)
        .body(body)
        .map_err(|e| AppError::InternalError(anyhow::anyhow!("Construction email : {e}")))?;

    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)
        .map_err(|e| AppError::InternalError(anyhow::anyhow!("SMTP relay : {e}")))?
        .port(config.smtp_port)
        .credentials(lettre::transport::smtp::authentication::Credentials::new(
            config.smtp_user.clone(),
            config.smtp_password.clone(),
        ))
        .build();

    mailer
        .send(message)
        .await
        .map_err(|e| AppError::InternalError(anyhow::anyhow!("Envoi email : {e}")))?;

    Ok(())
}
