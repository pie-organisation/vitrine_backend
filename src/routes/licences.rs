use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::AppError, middleware::auth::AuthUser, models::licence::Licence};

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AssignLicenceRequest {
    pub utilisateur_id: Uuid,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// GET /licences
/// Retourne toutes les licences de l'école de l'utilisateur authentifié.
pub async fn list_licences(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
) -> Result<Json<Vec<Licence>>, AppError> {
    let licences = sqlx::query_as::<_, Licence>(
        "SELECT * FROM licence WHERE ecole_id = $1 ORDER BY date_creation DESC",
    )
    .bind(auth_user.ecole_id)
    .fetch_all(&pool)
    .await?;

    Ok(Json(licences))
}

/// PATCH /licences/:id/assign
/// Assigne une licence disponible à un utilisateur de l'école.
pub async fn assign_licence(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
    Path(licence_id): Path<Uuid>,
    Json(body): Json<AssignLicenceRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Vérification que la licence appartient à l'école et est bien disponible
    let rows = sqlx::query(
        r#"
        UPDATE licence
        SET utilisateur_id = $1, statut = 'assignee'
        WHERE id = $2
          AND ecole_id = $3
          AND statut = 'disponible'
        "#,
    )
    .bind(body.utilisateur_id)
    .bind(licence_id)
    .bind(auth_user.ecole_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound(
            "Licence introuvable, déjà assignée ou n'appartient pas à votre école".to_string(),
        ));
    }

    tracing::info!(
        licence_id = %licence_id,
        utilisateur_id = %body.utilisateur_id,
        "Licence assignée"
    );

    Ok(Json(serde_json::json!({ "message": "Licence assignée avec succès" })))
}

/// PATCH /licences/:id/unassign
/// Libère une licence (remet le statut à "disponible").
pub async fn unassign_licence(
    State(pool): State<PgPool>,
    Extension(auth_user): Extension<AuthUser>,
    Path(licence_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = sqlx::query(
        r#"
        UPDATE licence
        SET utilisateur_id = NULL, statut = 'disponible', nb_sessions_actives = 0
        WHERE id = $1
          AND ecole_id = $2
          AND statut = 'assignee'
        "#,
    )
    .bind(licence_id)
    .bind(auth_user.ecole_id)
    .execute(&pool)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(AppError::NotFound(
            "Licence introuvable ou non assignée".to_string(),
        ));
    }

    Ok(Json(serde_json::json!({ "message": "Licence libérée avec succès" })))
}
