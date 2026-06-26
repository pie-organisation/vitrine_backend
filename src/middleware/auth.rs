use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// Claims encodés dans le JWT
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Identifiant de l'utilisateur
    pub sub: Uuid,
    pub ecole_id: Uuid,
    /// "eleve" | "enseignant" | "admin"
    pub role: String,
    /// Timestamp d'expiration (Unix seconds)
    pub exp: u64,
}

/// Extension injectée dans les handlers après validation JWT
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub ecole_id: Uuid,
    pub role: String,
}

/// Middleware : extrait et valide le JWT Bearer depuis Authorization header.
/// L'état reçu est la clé secrète JWT (passée via from_fn_with_state).
pub async fn require_auth(
    State(jwt_secret): State<String>,
    mut request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = extract_bearer_token(&request)?;

    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map_err(|_| AppError::Unauthorized)?
    .claims;

    request.extensions_mut().insert(AuthUser {
        user_id: claims.sub,
        ecole_id: claims.ecole_id,
        role: claims.role,
    });

    Ok(next.run(request).await)
}

/// Middleware : vérifie que l'utilisateur authentifié a le rôle "admin".
/// Doit être placé après require_auth dans la chaîne de middlewares.
pub async fn require_admin(
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let auth_user = request
        .extensions()
        .get::<AuthUser>()
        .ok_or(AppError::Unauthorized)?
        .clone();

    if auth_user.role != "admin" {
        return Err(AppError::Forbidden("Rôle admin requis".to_string()));
    }

    Ok(next.run(request).await)
}

fn extract_bearer_token(request: &Request) -> Result<&str, AppError> {
    let header = request
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;

    header
        .strip_prefix("Bearer ")
        .ok_or(AppError::Unauthorized)
}
