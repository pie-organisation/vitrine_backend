use axum::{extract::State, Extension, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::AppError, middleware::auth::AuthUser};

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct OpenSessionRequest {
    pub ip_origine: Option<String>,
    pub appareil_os: Option<String>,
    /// "normale" | "examen" | "supervisee" (défaut: "normale")
    pub type_session: Option<String>,
}

#[derive(Serialize)]
pub struct OpenSessionResponse {
    pub session_id: Uuid,
    pub token_session: String,
}

#[derive(Deserialize)]
pub struct CloseSessionRequest {
    pub session_id: Uuid,
}

// Struct locale pour mapper le résultat de la requête licence
#[derive(sqlx::FromRow)]
struct LicenceCheck {
    id: Uuid,
    nb_sessions_actives: i32,
    sessions_max: Option<i32>,
}

// Struct locale pour mapper la session lors de la fermeture
#[derive(sqlx::FromRow)]
struct SessionCheck {
    id: Uuid,
    licence_id: Uuid,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// POST /sessions/open
/// Ouvre une nouvelle session desktop pour l'utilisateur authentifié.
/// Vérifie qu'aucune session active n'existe déjà (via middleware session_guard).
/// Vérifie que le quota de sessions de la licence n'est pas atteint.
pub async fn open_session(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
    Json(body): Json<OpenSessionRequest>,
) -> Result<Json<OpenSessionResponse>, AppError> {
    // Récupération de la licence active assignée à l'utilisateur
    let licence = sqlx::query_as::<_, LicenceCheck>(
        r#"
        SELECT l.id, l.nb_sessions_actives, tl.sessions_max
        FROM licence l
        JOIN type_licence tl ON tl.id = l.type_licence_id
        WHERE l.utilisateur_id = $1
          AND l.statut = 'assignee'
          AND (l.date_fin IS NULL OR l.date_fin >= CURRENT_DATE)
        "#,
    )
    .bind(auth_user.user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Aucune licence active pour cet utilisateur".to_string()))?;

    // Vérification du quota de sessions (sessions_max NULL = illimité)
    if let Some(max) = licence.sessions_max {
        if licence.nb_sessions_actives >= max {
            return Err(AppError::Conflict(
                "Le quota de sessions simultanées est atteint pour cette licence".to_string(),
            ));
        }
    }

    let session_id = Uuid::new_v4();
    let token_session = Uuid::new_v4().to_string();
    let type_session = body.type_session.unwrap_or_else(|| "normale".to_string());

    // Insertion de la session et incrémentation du compteur en transaction atomique
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO session (id, utilisateur_id, licence_id, token_session, ip_origine, appareil_os, statut, type_session)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
        "#,
    )
    .bind(session_id)
    .bind(auth_user.user_id)
    .bind(licence.id)
    .bind(&token_session)
    .bind(&body.ip_origine)
    .bind(&body.appareil_os)
    .bind(&type_session)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE licence SET nb_sessions_actives = nb_sessions_actives + 1 WHERE id = $1",
    )
    .bind(licence.id)
    .execute(&mut *tx)
    .await?;

    // Journalisation de la connexion
    let details = body.appareil_os.as_deref().map(|os| format!("OS: {os}"));
    sqlx::query(
        "INSERT INTO log_activite (session_id, action, details) VALUES ($1, 'connexion', $2)",
    )
    .bind(session_id)
    .bind(details)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::info!(
        user_id = %auth_user.user_id,
        session_id = %session_id,
        "Session ouverte"
    );

    Ok(Json(OpenSessionResponse {
        session_id,
        token_session,
    }))
}

/// POST /sessions/close
/// Termine une session active et libère un slot de la licence.
pub async fn close_session(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
    Json(body): Json<CloseSessionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Vérification que la session appartient bien à l'utilisateur authentifié
    let session = sqlx::query_as::<_, SessionCheck>(
        "SELECT id, licence_id FROM session WHERE id = $1 AND utilisateur_id = $2 AND statut = 'active'",
    )
    .bind(body.session_id)
    .bind(auth_user.user_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session active introuvable".to_string()))?;

    let mut tx = pool.begin().await?;

    sqlx::query(
        "UPDATE session SET statut = 'terminee', date_fin = NOW() WHERE id = $1",
    )
    .bind(session.id)
    .execute(&mut *tx)
    .await?;

    // Décrémentation avec plancher à 0 pour éviter les valeurs négatives
    sqlx::query(
        "UPDATE licence SET nb_sessions_actives = GREATEST(0, nb_sessions_actives - 1) WHERE id = $1",
    )
    .bind(session.licence_id)
    .execute(&mut *tx)
    .await?;

    // Journalisation de la déconnexion
    sqlx::query(
        "INSERT INTO log_activite (session_id, action) VALUES ($1, 'deconnexion')",
    )
    .bind(session.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::info!(
        user_id = %auth_user.user_id,
        session_id = %session.id,
        "Session fermée"
    );

    Ok(Json(serde_json::json!({ "message": "Session terminée" })))
}
