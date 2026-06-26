use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Ressource introuvable : {0}")]
    NotFound(String),

    #[error("Non autorisé")]
    Unauthorized,

    #[error("Accès interdit : {0}")]
    Forbidden(String),

    /// Session déjà active pour cet utilisateur
    #[error("Conflit : {0}")]
    Conflict(String),

    #[error("Erreur de validation : {0}")]
    ValidationError(String),

    #[error("Erreur de base de données")]
    DatabaseError(#[from] sqlx::Error),

    #[error("Erreur interne")]
    InternalError(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg.clone()),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authentification requise".to_string(),
            ),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, "FORBIDDEN", msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, "CONFLICT", msg.clone()),
            AppError::ValidationError(msg) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "VALIDATION_ERROR",
                msg.clone(),
            ),
            AppError::DatabaseError(e) => {
                tracing::error!("Erreur base de données : {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATABASE_ERROR",
                    "Erreur interne du serveur".to_string(),
                )
            }
            AppError::InternalError(e) => {
                tracing::error!("Erreur interne : {e:?}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Erreur interne du serveur".to_string(),
                )
            }
        };

        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}
