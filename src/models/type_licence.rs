use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TypeLicence {
    pub id: Uuid,
    pub nom: String,
    pub sessions_min: i32,
    /// NULL = illimité (Licence 3 personnalisable)
    pub sessions_max: Option<i32>,
    pub prix_unitaire: Decimal,
    pub personnalisable: bool,
    pub ressources_cpu: i32,
    pub ressources_ram_go: i32,
    pub actif: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTypeLicence {
    pub nom: String,
    pub sessions_min: i32,
    pub sessions_max: Option<i32>,
    pub prix_unitaire: Decimal,
    pub personnalisable: bool,
    pub ressources_cpu: i32,
    pub ressources_ram_go: i32,
}
